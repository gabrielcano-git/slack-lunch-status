# Slack Lunch Status

Automação serverless para o Slack: às **12h** troca o status para `🍽️ Almoçando`; às **13h30** restaura o status anterior, respeitando expirações e alterações manuais. Horário: `America/Sao_Paulo`.

## Arquitetura

`GitHub Actions (WIF) → Cloud Run ← Cloud Scheduler (OIDC)`; Cloud Run lê um **User OAuth Token** do **Secret Manager**, utiliza **Firestore** para persistir o estado por data e chama a **Slack Web API**.

A API HTTP tem endpoints `POST /lunch/start`, `POST /lunch/end` e `GET /health`. O serviço Cloud Run deve permanecer **privado**; somente a service account do Cloud Scheduler tem `roles/run.invoker`. Não use `--allow-unauthenticated`.

### Comportamento e proteção

- Armazena o status anterior **antes** de sobrescrevê-lo, inclusive emoji e expiração.
- Status de almoço fica sem expiração automática para diferenciar limpeza manual de expiração.
- Não restaura status anteriores que já expiraram.
- Se o usuário trocar ou limpar o status durante o almoço, preserva a escolha manual.
- Repete chamadas sem sobrescrever o backup; utiliza transações Firestore para estado compartilhado.
- Se o processo falhar entre escrever Slack e atualizar Firestore, a próxima tentativa recupera o estado.
- Mantém somente um documento por data; histórico de estados pode ser limpo por política de retenção do Firestore.
- Limitação: alterações manuais que definam exatamente o mesmo texto, emoji e expiração do status de almoço são indistinguíveis. Um status alterado no instante entre a segunda verificação e a atualização do Slack também pode sofrer uma condição de corrida, pois a API do Slack não oferece compare-and-swap.

## 1. Criar aplicativo Slack

Em [Slack API — Apps](https://api.slack.com/apps), crie um app **From a manifest** usando este YAML:

```yaml
_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: Lunch Status
  description: Automatiza o status de almoço no Slack.
  background_color: '#2C2D30'
oauth_config:
  scopes:
    user:
      - users.profile:read
      - users.profile:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Instale o app e copie seu **User OAuth Token** (`xoxp-...`). Dependendo das políticas do workspace, pode ser necessária aprovação administrativa. Não use bot token `xoxb-...`.

## 2. Preparar o projeto Google Cloud

No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto com faturamento habilitado, abra o **Cloud Shell** e ajuste `PROJECT_ID` abaixo:

```bash
export PROJECT_ID="SEU_PROJECT_ID"
export REGION="southamerica-east1"
export REPO="gabrielcano-git/slack-lunch-status"
gcloud config set project "$PROJECT_ID"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com
```

Em **Firestore → Create database**, crie o banco `(default)` em **Native mode**, preferencialmente na região de São Paulo quando disponível. Banco padrão e modos não podem ser presumidos como já configurados.

## 3. Criar Secret Manager e contas de serviço

```bash
# Digite seu token Slack de maneira oculta no terminal; nunca salve no repositório.
read -rsp 'Token xoxp do Slack: ' SLACK_TOKEN; echo
printf '%s' "$SLACK_TOKEN" | gcloud secrets create slack-user-token --data-file=- --replication-policy=automatic
unset SLACK_TOKEN

gcloud iam service-accounts create slack-lunch-run --display-name='Slack Lunch Runtime'
gcloud iam service-accounts create slack-lunch-deploy --display-name='GitHub Cloud Run Deployer'
gcloud iam service-accounts create slack-lunch-scheduler --display-name='Cloud Scheduler Invoker'

export RUN_SA="slack-lunch-run@${PROJECT_ID}.iam.gserviceaccount.com"
export DEPLOY_SA="slack-lunch-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
export SCHEDULER_SA="slack-lunch-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUN_SA" --role=roles/datastore.user

gcloud secrets add-iam-policy-binding slack-user-token \
  --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor
```

Se o segredo `slack-user-token` já existir, use `gcloud secrets versions add slack-user-token --data-file=-` no lugar de `secrets create`.

## 4. Configurar a identidade federada GitHub → Google Cloud

Crie pool e provider OIDC restringindo **repositório e branch**. O token é emitido pelo próprio GitHub: não é preciso chave JSON.

```bash
gcloud iam workload-identity-pools create github \
  --location=global --display-name='GitHub Actions'

gcloud iam workload-identity-pools providers create-oidc slack-lunch \
  --location=global \
  --workload-identity-pool=github \
  --display-name='Slack Lunch GitHub' \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition="assertion.repository == '${REPO}' && assertion.ref == 'refs/heads/main'"

export POOL_PATH="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"
export WIF_PROVIDER="${POOL_PATH}/providers/slack-lunch"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_PATH}/attribute.repository/${REPO}"
```

Conceda as permissões de implantação (restrinja-as ao projeto dedicado a esta automação):

```bash
for ROLE in roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOY_SA" --role="$ROLE"
done

gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
```

O deploy a partir do código usa Cloud Build. Conceda `roles/run.builder` à **service account de build efetivamente utilizada** pelo projeto (veja [documentação oficial](https://docs.cloud.google.com/run/docs/configuring/services/build-service-account)); a identidade padrão depende da configuração/idade do projeto. Por exemplo, se for a Compute Engine default service account:

```bash
export BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$BUILD_SA" --role=roles/run.builder
```

O primeiro deploy também pode solicitar configuração inicial do Artifact Registry/Cloud Build. Consulte os logs do build caso falte alguma permissão.

## 5. Configurar as variáveis do GitHub Actions

Abra [Settings → Secrets and variables → Actions → Variables](https://github.com/gabrielcano-git/slack-lunch-status/settings/variables/actions). Cadastre como **Repository variables** (não são segredos):

| Nome | Valor |
|---|---|
| `GCP_PROJECT_ID` | Seu ID de projeto no Google Cloud |
| `WIF_PROVIDER` | Valor de `$WIF_PROVIDER` |
| `DEPLOY_SERVICE_ACCOUNT` | Valor de `$DEPLOY_SA` |
| `RUN_SERVICE_ACCOUNT` | Valor de `$RUN_SA` |

No GitHub, abra **Settings → Environments** e crie o ambiente `production`. O workflow está configurado para usar esse ambiente. Para a primeira implantação, vá em **Actions → Deploy Cloud Run → Run workflow**. Os pushes na `main` também disparam o deploy, se as variáveis estiverem preenchidas. O CI executa em pull requests sem acessar credenciais de nuvem.

O workflow utiliza `google-github-actions/auth@v3` com **Workload Identity Federation** e `gcloud run deploy --source .` para construir e publicar a imagem, injetando `SLACK_USER_TOKEN` do Secret Manager. Não configure tokens Slack no GitHub.

## 6. Criar agendamentos (após o primeiro deploy)

Execute no Cloud Shell, mantendo as variáveis da etapa 3 (ou exportando-as novamente):

```bash
export SERVICE_URL="$(gcloud run services describe slack-lunch-status \
  --region="$REGION" --format='value(status.url)')"

gcloud run services add-iam-policy-binding slack-lunch-status \
  --region="$REGION" \
  --member="serviceAccount:$SCHEDULER_SA" \
  --role=roles/run.invoker

# Início: 12h00 todos os dias
gcloud scheduler jobs create http slack-lunch-start \
  --location="$REGION" \
  --schedule='0 12 * * *' \
  --time-zone='America/Sao_Paulo' \
  --uri="${SERVICE_URL}/lunch/start" \
  --http-method=POST \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-token-audience="$SERVICE_URL"

# Fim: 13h30 todos os dias
gcloud scheduler jobs create http slack-lunch-end \
  --location="$REGION" \
  --schedule='30 13 * * *' \
  --time-zone='America/Sao_Paulo' \
  --uri="${SERVICE_URL}/lunch/end" \
  --http-method=POST \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-token-audience="$SERVICE_URL"
```

Para executar **só de segunda a sexta**, troque os cron por `0 12 * * 1-5` e `30 13 * * 1-5`.

## 7. Testar e observar

```bash
# Execute em sequência: confira o status Slack entre as chamadas.
gcloud scheduler jobs run slack-lunch-start --location="$REGION"
gcloud scheduler jobs run slack-lunch-end --location="$REGION"

# Logs
gcloud run services logs read slack-lunch-status --region="$REGION" --limit=50
```

O Scheduler pode levar alguns segundos para executar o job. Se você reiniciar o teste no mesmo dia, o documento diário já estará `done`; não será iniciado novamente. Para um segundo teste no mesmo dia, use um novo documento/data em ambiente isolado ou reinicie com cuidado o documento daquele dia no Firestore, apenas se tiver certeza de que não há uma sessão ativa. Teste o fluxo completo antes de confiar nos horários automáticos.

## Desenvolvimento local

Node.js 22+:

```bash
npm install
npm test
npm run build
```

Para executar localmente, configure `SLACK_USER_TOKEN` via ambiente, e credenciais do Google Cloud ADC com `gcloud auth application-default login`. Não execute contra o Firestore de produção em testes automatizados: os testes utilizam fakes em memória.

## Notas de segurança e custo

- O serviço Cloud Run é privado e o Scheduler o invoca por OIDC; não use invocação sem autenticação.
- O token Slack é sensível e deve permanecer no Secret Manager.
- Cloud Scheduler pode repetir chamadas; endpoints respondem de maneira idempotente por data.
- O Cloud Run/Firestore/Scheduler/Secret Manager podem gerar cobrança. Confira os limites e cobranças antes de implantar.
- A automação modifica **status do perfil**, não o estado de presença (ativo/ausente).
- O Slack não possui operação atômica para `get` + `set`; mudanças exatamente simultâneas à escrita são uma limitação conhecida.

Referências: [Slack get](https://docs.slack.dev/reference/methods/users.profile.get/), [Slack set](https://docs.slack.dev/reference/methods/users.profile.set/), [Cloud Run Scheduler](https://docs.cloud.google.com/run/docs/triggering/using-scheduler), [GitHub auth](https://github.com/google-github-actions/auth).
