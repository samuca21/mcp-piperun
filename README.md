# mcp-piperun — Test helpers

Este repositório contém o servidor MCP para integração com PipeRun, além de um pequeno script para testar a ferramenta `resolve_deal_owner` localmente.

Como testar localmente:

1. Instale dependências:

```bash
npm install
```

2. Rodar o script de teste (substitua `TOKEN`):

```bash
TOKEN="<seu token>" node scripts/test_resolve_deal_owner.js --pipeline_name=Vendas
```

3. Alternativamente execute o npm script:

```bash
npm run test:resolve-deal-owner
```

Notas:
- O script aceita `--deal_id`, `--deal_title`, `--pipeline_name`, `--owner_name`.
- O objetivo é simular a tool `resolve_deal_owner` e validar que conseguimos resolver ids e nomes de `deal`, `pipeline` e `owner`.
