# Modelos de documento legados: atualização e geração

Registro de testes na conta Questor em 27/11/2026. As ferramentas MCP citadas abaixo estão na versão customizada usada pela Questor e podem não estar disponíveis na branch principal deste repositório. A API de documentos não é coberta pelas ferramentas públicas gerais do PipeRun; valide o comportamento na conta antes de mudanças em produção. Não registre tokens ou dados de clientes nos exemplos.

## Rotas e ferramentas

- Documentos antigos (engines 1 e 3): `GET /v1/documentModels/{id}` retorna o modelo com `pages[]`; o HTML fica em `pages[].text`. `POST /v1/documentPages` cria uma página, `PUT /v1/documentPages/{id}` atualiza e `DELETE /v1/documentPages/{id}` remove. O MCP oferece `get_legacy_document_model` e `update_legacy_document_page`; criação e remoção de páginas foram testadas diretamente na API.
- Geração antiga: `POST /v1/documentModels/{id}/generate`, JSON `{"deal_id":"..."}`. No MCP, use `generate_document` com `legacy=true`. Uma geração bem-sucedida **salva um PDF nos arquivos da oportunidade**.
- Tela nova (engine 4): `/v1/document/models`. É um recurso diferente. Um `PUT /v1/document/models/11828` para o modelo antigo 9999, mesmo informando `engine=1`, retornou 404. Atualizar um modelo de teste novo com `engine=1` respondeu 200, mas depois ele passou a ser consultado na rota antiga e ficou sem páginas: isso não comprova migração ou atualização válida de documento legado.
- Informe explicitamente `engine=1` e preserve a `preference` existente em cada página. Não confunda estes documentos com os layouts de proposta, cuja rota de atualização usada no teste foi `PUT /v1/proposals/layouts/{id}`; naquele recurso, omitir `engine=1` redefiniu a engine para 3.

## Limite e divisão do HTML

Na conta Questor, tanto `PUT /v1/documentPages/{id}` como `POST /v1/documentPages` recusaram um campo `text` longo com HTTP 422: **“O campo texto não pode conter mais de 16383 caracteres.”** Um HTML já existente tinha aproximadamente 67 mil caracteres, e uma requisição antiga no Talend tinha mais de 72 mil. Isso não significa que a API atual aceite regravá-los: o teste com 50.767 caracteres também foi recusado. A API pode normalizar o HTML armazenado, que depois da gravação pode aparecer com comprimento maior que o texto enviado; a validação observada foi no envio.

Para contratos maiores:

1. Exporte o modelo completo e guarde uma cópia das páginas, dos IDs, da ordem, da engine, da preferência e dos funis. A API rejeitou regravar o original de 67 mil caracteres em uma única página; o backup é essencial, mas a restauração integral em uma única página não foi demonstrada.
2. Divida por mudanças de seção, mantendo textos, cláusulas, variáveis e sua ordem. Faça os cortes fora de blocos condicionais ou laços abertos, e confira a estrutura HTML. Garanta que **cada texto enviado** fique abaixo do limite.
3. No contrato 3275, a divisão validada foi: Anexo II; contrato seções 1–3; seções 4–6; seções 7–9; seções 10–14; Anexo I. Use a ordem para montar os blocos no modelo. Os pontos exatos variam conforme o conteúdo; não suponha que qualquer divisão será válida.
4. Cada página criada já provoca uma quebra no documento gerado. Elimine somente as quebras de página redundantes na transição entre blocos: no teste, duas quebras duplicadas causavam páginas em branco. Mantenha as demais quebras necessárias.
5. Teste um modelo isolado antes de alterar produção, aguarde alguns segundos após gravar por causa do cache e gere o PDF. Confira conteúdo, sequência, valores, condições, páginas vazias, logo e variáveis literais. Um primeiro teste com sete partes falhou com erro de sintaxe; seis blocos nas seções produziram um único PDF. A causa do primeiro erro não foi identificada.

## Preferência e proposta aprovada

No modelo 3275, cada página usa `engine=1` e `preference=2`. Com a proposta de teste ainda não aprovada, o PDF gerado com preferência 2 exibiu expressões como `@if` e `{{ $nro_orcamento }}` literalmente. Após aprovar a proposta de teste, a mesma configuração processou as instruções e preencheu a cotação e os valores. Isso confirma o comportamento **neste cenário**, sem estabelecer o significado completo de todos os valores de `preference` ou de status em todas as contas. Não mude a preferência de um modelo oficial para contornar um teste sem entender o efeito.

O teste foi feito com o modelo temporário `9999 - documento teste` (11828), a oportunidade 66063410 e a proposta QTR62126 (4591606). O 9999 foi restaurado após os testes; a proposta de teste foi aprovada. O contrato oficial `01 - Contrato de Locação - Questor Sistemas` (3275) foi atualizado em seis páginas mantendo engine 1 e preferência 2 e gerou um PDF de 18 páginas, sem páginas vazias, com os dados da proposta aprovada.

## Logo no contrato legado

No layout oficial de proposta, uma logo PNG incorporada como `data:image/png;base64,...` apareceu laranja. No documento legado testado, a logo em base64 não apareceu; a causa não foi identificada. A URL externa oficial `https://questor.com.br/images/LogoQuestor.webp`, dentro de célula de tabela, apareceu laranja no PDF do contrato legado. A geração depende da disponibilidade dessa URL; valide a imagem em PDFs futuros. Não generalize que base64 ou WebP funcionem em todas as engines.

## Limites do teste

Os testes de conteúdo preencheram a proposta usada no cenário; não constituem validação de todos os ramos de dados (pessoa física/jurídica, produtos e combinações de pagamento). Antes de colocar outras alterações em uso, teste os cenários relevantes. O contrato original não deve ser substituído sem autorização explícita e sem preservar suas cláusulas.
