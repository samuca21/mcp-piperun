# feat: normaliza datas (YYYY-MM-DD) e adiciona resolve_deal_owner (enriquecimento)

## Descrição

Corrige 422 ao criar/atualizar activities no PipeRun garantindo que `start_at`/`end_at` sejam enviados no formato Y-m-d (YYYY-MM-DD). Adiciona a tool `resolve_deal_owner` que resolve/enriquece `deal`/`pipeline`/`owner` por id ou nome, e um script de teste local.

## Mudanças principais

- Helper de datas: adiciona `formatDateToYmd()` e validação de datas.
- Normalização: formata `start_at` e `end_at` antes de enviar em endpoints de criação/atualização de activities, meetings e followups.
- Nova tool: `resolve_deal_owner` — busca `pipelines`, `users` e `deals`, resolve ids <-> nomes e retorna objeto enriquecido.
- Script de teste: `scripts/test_resolve_deal_owner.js` para simular a tool localmente com um token.

## Como testar localmente

1) Instale dependências:

```bash
npm install
```

2) Validar endpoints PipeRun:

```bash
TOKEN="<your token>"
curl -s -H "token: $TOKEN" "https://api.pipe.run/v1/pipelines" | jq '.'
curl -s -H "token: $TOKEN" "https://api.pipe.run/v1/users" | jq '.'
```

3) Rodar o script que simula a tool:

```bash
TOKEN="<your token>" node scripts/test_resolve_deal_owner.js --pipeline_name=Vendas
# ou por deal id
TOKEN="<your token>" node scripts/test_resolve_deal_owner.js --deal_id=55317064
```

4) Exercitar criação/atualização de activity (verificar que `start_at`/`end_at` no request body estão em `YYYY-MM-DD`):

```bash
curl -X POST -H "token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Teste","activity_type_id":243787,"status":0,"start_at":"2026-01-10","end_at":"2026-01-10"}' \
  https://api.pipe.run/v1/activities
```

## Observações
- A tool `resolve_deal_owner` é tolerante a formatos de retorno da API (top-level ou dentro de `data`).
- A validação de datas torna erros mais claros localmente, evitando 422s por payloads inválidos.
