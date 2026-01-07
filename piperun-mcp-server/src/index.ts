#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";

import axios, { AxiosError } from "axios";

// IMPORTANTE (MCP stdio): qualquer saída em stdout quebra o protocolo.
// Forçamos logs para stderr para evitar que dependências usem stdout.
// (As respostas das tools continuam indo pelo protocolo MCP, não via console.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(console as any).log = (...args: any[]) => console.error(...args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(console as any).info = (...args: any[]) => console.error(...args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(console as any).warn = (...args: any[]) => console.error(...args);


// 2. Configurar instância do Axios (sem token global)
const PIPERUN_API_BASE_URL = "https://api.pipe.run/v1";
const axiosInstance = axios.create({
  baseURL: PIPERUN_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// ActivityType IDs (conta do cliente). Defaults apenas para tipo de atividade.
// Pipeline/Stage NÃO possuem defaults.
const ACTIVITY_TYPE_MEETING_ID_DEFAULT = 243787;
const ACTIVITY_TYPE_CALL_ID_DEFAULT = 243785;

function normalizeEmail(v?: string): string {
  return (v || "").trim().toLowerCase();
}

function normalizePhone(v?: string): string {
  return (v || "")
    .toString()
    .trim()
    .replace(/[^0-9+]/g, "")
    .replace(/^00/, "+");
}

async function listAllPages<T>(opts: {
  endpoint: string;
  params: Record<string, any>;
  headers: Record<string, any>;
  maxPages?: number;
  show?: number;
}): Promise<T[]> {
  const out: T[] = [];
  const maxPages = Math.max(1, Math.min(20, opts.maxPages ?? 5));
  const show = Math.max(1, Math.min(200, opts.show ?? 200));

  for (let page = 1; page <= maxPages; page++) {
    const resp = await axiosInstance.get(opts.endpoint, {
      params: { ...opts.params, page, show },
      headers: opts.headers,
    });

    const data = (resp.data as any)?.data;
    if (Array.isArray(data)) {
      out.push(...(data as T[]));
      if (data.length < show) break;
    } else if (Array.isArray(resp.data)) {
      out.push(...(resp.data as T[]));
      if ((resp.data as any[]).length < show) break;
    } else {
      break;
    }
  }

  return out;
}

function findPersonMatch(person: any, email?: string, phone?: string): boolean {
  const e = normalizeEmail(email);
  const p = normalizePhone(phone);

  const emailCandidates: string[] = [];
  if (typeof person?.email === "string") emailCandidates.push(person.email);
  if (Array.isArray(person?.emails)) {
    for (const it of person.emails) {
      if (typeof it === "string") emailCandidates.push(it);
      else if (typeof it?.value === "string") emailCandidates.push(it.value);
      else if (typeof it?.email === "string") emailCandidates.push(it.email);
    }
  }

  const phoneCandidates: string[] = [];
  if (typeof person?.phone === "string") phoneCandidates.push(person.phone);
  if (Array.isArray(person?.phones)) {
    for (const it of person.phones) {
      if (typeof it === "string") phoneCandidates.push(it);
      else if (typeof it?.value === "string") phoneCandidates.push(it.value);
      else if (typeof it?.phone === "string") phoneCandidates.push(it.phone);
    }
  }

  const hasEmailMatch = !!e && emailCandidates.map(normalizeEmail).includes(e);
  const hasPhoneMatch = !!p && phoneCandidates.map(normalizePhone).includes(p);

  return hasEmailMatch || hasPhoneMatch;
}

function findCompanyMatch(company: any, domain?: string, name?: string): boolean {
  const d = (domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
  const n = (name || "").trim().toLowerCase();

  const companyName = (company?.name || "").toString().trim().toLowerCase();
  const website = (company?.website || company?.site || "").toString().trim().toLowerCase();
  const websiteNorm = website
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

  const byDomain = !!d && (websiteNorm === d || websiteNorm.endsWith("." + d));
  const byName = !!n && companyName === n;

  return byDomain || byName;
}

function stableHash(str: string): number {
  // djb2
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return Math.abs(h >>> 0);
}

// Normaliza datas para formato Y-m-d (YYYY-MM-DD) exigido pela API PipeRun
function formatDateToYmd(val: any): string {
  const s = val === undefined || val === null ? "" : String(val).trim();
  if (!s) throw new McpError(ErrorCode.InvalidParams, `Data inválida ou vazia: ${s}`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new McpError(ErrorCode.InvalidParams, `Data inválida: ${s}. Aguarde formato ISO ou YYYY-MM-DD.`);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Interface para validação dos argumentos de create_person
interface CreatePersonArgs {
  name: string;
  owner_id: number;
  email?: string;
  phone?: string;
  company_id?: number;
}

// Função de type guard para validar os argumentos de create_person
function isValidCreatePersonArgs(args: any): args is CreatePersonArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof args.name === "string" &&
    args.name.trim() !== "" &&
    typeof args.owner_id === "number" &&
    (args.email === undefined || typeof args.email === "string") &&
    (args.phone === undefined || typeof args.phone === "string") &&
    (args.company_id === undefined || typeof args.company_id === "number")
  );
}

// Interface para validação dos argumentos de create_note
interface CreateNoteArgs {
  content: string;
  deal_id?: number;
  person_id?: number;
  company_id?: number;
}

// Função de type guard para validar os argumentos de create_note
function isValidCreateNoteArgs(args: any): args is CreateNoteArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof args.content === "string" &&
    args.content.trim() !== "" &&
    (typeof args.deal_id === "number" ||
      typeof args.person_id === "number" ||
      typeof args.company_id === "number")
  );
}

// Helper: resolve token (tool param tem prioridade, senão env var)
function resolveApiToken(args: any): string {
  const fromArgs =
    args &&
    typeof args === "object" &&
    typeof (args as any).api_token === "string" &&
    (args as any).api_token.trim()
      ? (args as any).api_token.trim()
      : "";

  const fromEnv = (process.env.PIPERUN_API_TOKEN || "").trim();
  const token = fromArgs || fromEnv;

  if (!token) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Faltando token: informe 'api_token' nos argumentos da ferramenta OU configure PIPERUN_API_TOKEN no ambiente."
    );
  }

  return token;
}

// 3. Criar o servidor MCP
const server = new Server(
  {
    name: "piperun-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 4. Handler para listar as ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // IMPORTANTE:
  // Deixamos api_token COMO OPCIONAL nos schemas para o n8n não travar exigindo o campo.
  // O token continua sendo validado no runtime (resolveApiToken).

  const listToolSimpleInputSchema = {
    type: "object",
    properties: {
      api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
    },
    required: [] as string[],
  };

  const listToolPaginatedInputSchema = {
    type: "object",
    properties: {
      api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
      page: { type: "number", description: "(Opcional) Número da página (padrão: 1)" },
      show: { type: "number", description: "(Opcional) Quantidade por página (padrão: 20, máx: 200)" },
    },
    required: [] as string[],
  };

  const listActivitiesInputSchema = {
    type: "object",
    properties: {
      api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
      page: { type: "number", description: "(Opcional) Número da página (padrão: 1)" },
      show: { type: "number", description: "(Opcional) Quantidade por página (padrão: 15, máx: 200)" },
      with: { type: "string", description: "(Opcional) Entidades relacionadas a incluir (ex: 'deal,owner')" },
      sort: { type: "string", description: "(Opcional) Coluna para ordenar" },
      desc: { type: "boolean", description: "(Opcional) Ordenar decrescente (true) ou crescente (false)" },
      deal_id: { type: "number", description: "(Opcional) Filtrar por ID da oportunidade" },
      owner_id: { type: "number", description: "(Opcional) Filtrar por ID do responsável" },
      requester_id: { type: "number", description: "(Opcional) Filtrar por ID do criador" },
      title: { type: "string", description: "(Opcional) Filtrar por título" },
      activity_type_id: { type: "number", description: "(Opcional) Filtrar por ID do tipo de atividade" },
      status: { type: "number", description: "(Opcional) Filtrar por status (0=Aberta, 2=Concluída, 4=No Show)" },
      start_at_start: { type: "string", format: "date-time", description: "(Opcional) Data/hora início (início período)" },
      start_at_end: { type: "string", format: "date-time", description: "(Opcional) Data/hora início (fim período)" },
      end_at_start: { type: "string", format: "date-time", description: "(Opcional) Data/hora fim (início período)" },
      end_at_end: { type: "string", format: "date-time", description: "(Opcional) Data/hora fim (fim período)" },
      created_at_start: { type: "string", format: "date-time", description: "(Opcional) Data/hora criação (início período)" },
      created_at_end: { type: "string", format: "date-time", description: "(Opcional) Data/hora criação (fim período)" },
      updated_at_start: { type: "string", format: "date-time", description: "(Opcional) Data/hora atualização (início período)" },
      updated_at_end: { type: "string", format: "date-time", description: "(Opcional) Data/hora atualização (fim período)" },
    },
    required: [] as string[],
  };

  return {
    tools: [
      {
        name: "list_deals",
        description: "Recupera uma lista de oportunidades do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            pipeline_id: { type: "number", description: "(Opcional) ID do funil para filtrar oportunidades" },
            person_id: { type: "number", description: "(Opcional) ID da pessoa para filtrar oportunidades" },
            page: { type: "number", description: "(Opcional) Número da página (padrão: 1)" },
            show: { type: "number", description: "(Opcional) Quantidade por página (padrão: 20, máx: 200)" },
          },
          required: [] as string[],
        },
      },
      // Aliases para oportunidades (vendas)
      {
        name: "list_opportunities",
        description: "Alias de list_deals (linguagem de vendas). Recupera uma lista de oportunidades do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            pipeline_id: { type: "number", description: "(Opcional) ID do funil para filtrar oportunidades." },
            person_id: { type: "number", description: "(Opcional) ID da pessoa para filtrar oportunidades" },
            page: { type: "number", description: "(Opcional) Número da página (padrão: 1)" },
            show: { type: "number", description: "(Opcional) Quantidade por página (padrão: 20, máx: 200)" },
          },
          required: [] as string[],
        },
      },
      {
        name: "get_opportunity",
        description: "Alias de get_deal (linguagem de vendas). Recupera os detalhes de uma oportunidade (deal) específica.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
          },
          required: ["deal_id"],
        },
      },
      {
        name: "create_opportunity",
        description: "Alias de create_deal (linguagem de vendas). Cria uma nova oportunidade no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            title: { type: "string", description: "Título da oportunidade" },
            pipeline_id: { type: "integer", description: "(Obrigatório) ID do funil." },
            stage_id: { type: "integer", description: "(Obrigatório) ID da etapa." },
            owner_id: { type: "integer", description: "(Opcional) ID do responsável" },
            value: { type: "number", description: "(Opcional) Valor da oportunidade" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
            deal_source_id: { type: "integer", description: "(Opcional) ID da origem do negócio" },
            loss_reason_id: { type: "integer", description: "(Opcional) ID do motivo de perda" },
          },
          required: ["title", "pipeline_id", "stage_id"],
          additionalProperties: true,
        },
      },
      {
        name: "update_opportunity",
        description: "Alias de update_deal (linguagem de vendas). Atualiza uma oportunidade existente.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
            title: { type: "string", description: "(Opcional) Título" },
            pipeline_id: { type: "integer", description: "(Opcional) ID do funil" },
            stage_id: { type: "integer", description: "(Opcional) ID da etapa" },
            owner_id: { type: "integer", description: "(Opcional) ID do responsável" },
            value: { type: "number", description: "(Opcional) Valor" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
          },
          required: ["deal_id"],
          additionalProperties: true,
        },
      },
      {
        name: "delete_opportunity",
        description: "Alias de delete_deal (linguagem de vendas). Remove uma oportunidade (deal) pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
          },
          required: ["deal_id"],
        },
      },

      {
        name: "get_deal",
        description: "Recupera os detalhes de uma oportunidade (deal) específica.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
          },
          required: ["deal_id"],
        },
      },
      {
        name: "create_deal",
        description: "Cria uma nova oportunidade (deal) no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            title: { type: "string", description: "Título da oportunidade" },
            pipeline_id: { type: "integer", description: "(Obrigatório) ID do funil." },
            stage_id: { type: "integer", description: "(Obrigatório) ID da etapa." },
            owner_id: { type: "integer", description: "(Opcional) ID do responsável" },
            value: { type: "number", description: "(Opcional) Valor da oportunidade" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
            deal_source_id: { type: "integer", description: "(Opcional) ID da origem do negócio" },
            loss_reason_id: { type: "integer", description: "(Opcional) ID do motivo de perda" },
          },
          required: ["title", "pipeline_id", "stage_id"],
          additionalProperties: true,
        },
      },
      {
        name: "update_deal",
        description: "Atualiza uma oportunidade (deal) existente no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
            title: { type: "string", description: "(Opcional) Título" },
            pipeline_id: { type: "integer", description: "(Opcional) ID do funil" },
            stage_id: { type: "integer", description: "(Opcional) ID da etapa" },
            owner_id: { type: "integer", description: "(Opcional) ID do responsável" },
            value: { type: "number", description: "(Opcional) Valor" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
          },
          required: ["deal_id"],
          additionalProperties: true,
        },
      },
      {
        name: "delete_deal",
        description: "Remove uma oportunidade (deal) pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
          },
          required: ["deal_id"],
        },
      },

      {
        name: "piperun_request",
        description:
          "Chama qualquer endpoint da API do PipeRun (uso avançado). Ex: GET /me, GET /deals, POST /activities, etc.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: {
              type: "string",
              description:
                "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente.",
            },
            method: {
              type: "string",
              description: "HTTP method: GET | POST | PUT | DELETE",
              enum: ["GET", "POST", "PUT", "DELETE"],
            },
            path: {
              type: "string",
              description:
                "Caminho a partir do /v1. Ex: /me, /deals, /activities, /calls, /customFields",
            },
            query: {
              type: "object",
              description: "(Opcional) Querystring como objeto",
              additionalProperties: true,
            },
            body: {
              type: "object",
              description: "(Opcional) Body JSON para POST/PUT",
              additionalProperties: true,
            },
          },
          required: ["method", "path"],
          additionalProperties: false,
        },
      },

      {
        name: "create_person",
        description: "Cria uma nova pessoa (lead/contato) no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            name: { type: "string", description: "Nome da pessoa" },
            owner_id: { type: "integer", description: "ID do usuário responsável" },
            email: { type: "string", description: "(Opcional) Email da pessoa" },
            phone: { type: "string", description: "(Opcional) Telefone da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa associada" },
          },
          required: ["name", "owner_id"],
          additionalProperties: true,
        },
      },
      {
        name: "list_persons",
        description: "Recupera uma lista de pessoas (leads/contatos) do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            page: { type: "number", description: "(Opcional) Número da página (padrão: 1)" },
            show: { type: "number", description: "(Opcional) Quantidade por página (padrão: 20, máx: 200)" },
            with: { type: "string", description: "(Opcional) Entidades relacionadas a incluir (ex: 'company,owner')" },
          },
          required: [] as string[],
        },
      },
      {
        name: "get_person",
        description: "Recupera os detalhes de uma pessoa (lead/contato) pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            person_id: { type: "integer", description: "ID da pessoa" },
          },
          required: ["person_id"],
        },
      },
      {
        name: "update_person",
        description: "Atualiza uma pessoa existente (lead/contato).",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            person_id: { type: "integer", description: "ID da pessoa" },
          },
          required: ["person_id"],
          additionalProperties: true,
        },
      },
      {
        name: "delete_person",
        description: "Remove uma pessoa (lead/contato) pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            person_id: { type: "integer", description: "ID da pessoa" },
          },
          required: ["person_id"],
        },
      },

      // Listagens
      { name: "list_pipelines", description: "Recupera uma lista de funis do PipeRun CRM.", inputSchema: listToolPaginatedInputSchema },
      {
        name: "list_stages",
        description: "Recupera uma lista de etapas de funil do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            ...listToolPaginatedInputSchema.properties,
            pipeline_id: { type: "number", description: "(Opcional) ID do funil para filtrar etapas" },
          },
          required: [] as string[],
        },
      },
      { name: "list_items", description: "Recupera uma lista de produtos do PipeRun CRM.", inputSchema: listToolPaginatedInputSchema },
      { name: "list_users", description: "Recupera uma lista de usuários (vendedores) do PipeRun CRM.", inputSchema: listToolPaginatedInputSchema },
      { name: "list_activities", description: "Recupera uma lista de atividades do PipeRun CRM.", inputSchema: listActivitiesInputSchema },
      { name: "list_calls", description: "Recupera uma lista de histórico de ligações do PipeRun CRM.", inputSchema: listToolPaginatedInputSchema },
      {
        name: "get_activity",
        description: "Recupera os detalhes de uma atividade específica.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            activity_id: { type: "integer", description: "ID da atividade" },
          },
          required: ["activity_id"],
        },
      },
      {
        name: "create_activity",
        description: "Cria uma nova atividade (tarefa/reunião) no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            title: { type: "string", description: "Título da atividade" },
            activity_type_id: { type: "integer", description: "ID do tipo de atividade (obrigatório)" },
            status: { type: "integer", description: "Status (obrigatório). Ex: 0=Aberta, 2=Concluída, 4=No Show" },
            owner_id: { type: "integer", description: "(Opcional) ID do responsável" },
            deal_id: { type: "integer", description: "(Opcional) ID da oportunidade" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
            start_at: { type: "string", description: "(Opcional) Início (date-time)" },
            end_at: { type: "string", description: "(Opcional) Fim (date-time)" },
            description: { type: "string", description: "(Opcional) Descrição" },
          },
          required: ["title", "activity_type_id", "status"],
          additionalProperties: true,
        },
      },
      {
        name: "update_activity",
        description: "Atualiza uma atividade existente.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            activity_id: { type: "integer", description: "ID da atividade" },
            title: { type: "string", description: "(Opcional) Título" },
            activity_type_id: { type: "integer", description: "(Opcional) Tipo" },
            status: { type: "integer", description: "(Opcional) Status" },
            owner_id: { type: "integer", description: "(Opcional) Responsável" },
            start_at: { type: "string", description: "(Opcional) Início (date-time)" },
            end_at: { type: "string", description: "(Opcional) Fim (date-time)" },
            description: { type: "string", description: "(Opcional) Descrição" },
          },
          required: ["activity_id"],
          additionalProperties: true,
        },
      },
      {
        name: "delete_activity",
        description: "Remove uma atividade pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            activity_id: { type: "integer", description: "ID da atividade" },
          },
          required: ["activity_id"],
        },
      },

            {
        name: "get_call",
        description: "Recupera os detalhes de um registro de ligação.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            call_id: { type: "integer", description: "ID do registro de ligação" },
          },
          required: ["call_id"],
        },
      },
      {
        name: "create_call",
        description: "Cria um registro de histórico de ligação no PipeRun.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." }
          },
          required: [],
          additionalProperties: true
        },
      },
      {
        name: "update_call",
        description: "Atualiza um registro de histórico de ligação.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            call_id: { type: "integer", description: "ID do registro de ligação" }
          },
          required: ["call_id"],
          additionalProperties: true
        },
      },
      {
        name: "delete_call",
        description: "Remove um registro de histórico de ligação.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            call_id: { type: "integer", description: "ID do registro de ligação" }
          },
          required: ["call_id"]
        },
      },

      // Empresas
      { name: "list_companies", description: "Recupera uma lista de empresas do PipeRun CRM.", inputSchema: listToolPaginatedInputSchema },
      {
        name: "get_company",
        description: "Recupera os detalhes de uma empresa específica do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            company_id: { type: "integer", description: "ID da empresa a ser recuperada" },
          },
          required: ["company_id"],
        },
      },
      {
        name: "create_company",
        description: "Cria uma nova empresa no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            name: { type: "string", description: "Nome da empresa" },
            owner_id: { type: "integer", description: "ID do usuário responsável" },
            email: { type: "string", description: "(Opcional) Email principal da empresa" },
            phone: { type: "string", description: "(Opcional) Telefone principal da empresa" },
          },
          required: ["name", "owner_id"],
          additionalProperties: true,
        },
      },
      {
        name: "update_company",
        description: "Atualiza os dados de uma empresa existente no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            company_id: { type: "integer", description: "ID da empresa a ser atualizada" },
            name: { type: "string", description: "(Opcional) Novo nome da empresa" },
            owner_id: { type: "integer", description: "(Opcional) Novo ID do usuário responsável" },
            email: { type: "string", description: "(Opcional) Novo email principal da empresa" },
            phone: { type: "string", description: "(Opcional) Novo telefone principal da empresa" },
          },
          required: ["company_id"],
        },
      },

      // Contexto / Classificação
      {
        name: "list_custom_fields",
        description: "Recupera uma lista de campos customizados do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
          },
          required: [] as string[],
        },
      },
      { name: "list_tags", description: "Recupera uma lista de tags do PipeRun CRM.", inputSchema: listToolSimpleInputSchema },
      { name: "list_loss_reasons", description: "Recupera uma lista de motivos de perda do PipeRun CRM.", inputSchema: listToolSimpleInputSchema },
      { name: "list_deal_sources", description: "Recupera uma lista de origens de oportunidades do PipeRun CRM.", inputSchema: listToolSimpleInputSchema },
      { name: "list_activity_types", description: "Recupera uma lista de tipos de atividades do PipeRun CRM.", inputSchema: listToolSimpleInputSchema },

      // Notas
      {
        name: "list_notes",
        description: "Recupera uma lista de notas do PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            page: { type: "number", description: "(Opcional) Número da página (padrão: 1)" },
            show: { type: "number", description: "(Opcional) Quantidade por página (padrão: 20, máx: 200)" },
            deal_id: { type: "number", description: "(Opcional) Filtrar por ID da oportunidade" },
            person_id: { type: "number", description: "(Opcional) Filtrar por ID da pessoa" },
            company_id: { type: "number", description: "(Opcional) Filtrar por ID da empresa" },
          },
          required: [] as string[],
        },
      },
      {
        name: "create_note",
        description: "Cria uma nova nota associada a uma oportunidade, pessoa ou empresa no PipeRun CRM.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            content: { type: "string", description: "Conteúdo da nota" },
            deal_id: { type: "number", description: "(Opcional) ID da oportunidade para associar a nota" },
            person_id: { type: "number", description: "(Opcional) ID da pessoa para associar a nota" },
            company_id: { type: "number", description: "(Opcional) ID da empresa para associar a nota" },
          },
          required: ["content"],
          anyOf: [
            { required: ["deal_id"] },
            { required: ["person_id"] },
            { required: ["company_id"] },
          ],
        },
      },
      {
        name: "get_note",
        description: "Recupera os detalhes de uma nota pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            note_id: { type: "integer", description: "ID da nota" },
          },
          required: ["note_id"],
        },
      },
      {
        name: "update_note",
        description: "Atualiza uma nota existente.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            note_id: { type: "integer", description: "ID da nota" },
            content: { type: "string", description: "(Opcional) Conteúdo da nota" },
            deal_id: { type: "number", description: "(Opcional) ID da oportunidade" },
            person_id: { type: "number", description: "(Opcional) ID da pessoa" },
            company_id: { type: "number", description: "(Opcional) ID da empresa" },
          },
          required: ["note_id"],
          additionalProperties: true,
        },
      },
      {
        name: "delete_note",
        description: "Remove uma nota pelo ID.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            note_id: { type: "integer", description: "ID da nota" },
          },
          required: ["note_id"],
        },
      },
      // ===== RevOps flow tools =====
      {
        name: "upsert_person_by_email_or_phone",
        description: "Busca pessoa por email/telefone. Se não encontrar, cria (requer owner_id para criar).",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            name: { type: "string", description: "Nome (usado para criar se não existir)" },
            owner_id: { type: "integer", description: "(Obrigatório para criar) ID do responsável" },
            email: { type: "string", description: "(Opcional) Email" },
            phone: { type: "string", description: "(Opcional) Telefone" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
            max_pages: { type: "integer", description: "(Opcional) Máx páginas para busca (padrão 5, máx 20)" },
            show: { type: "integer", description: "(Opcional) Itens por página (padrão 200, máx 200)" }
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "upsert_company_by_domain_or_name",
        description: "Busca empresa por domínio/site ou nome. Se não encontrar, cria (requer owner_id para criar).",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            name: { type: "string", description: "Nome (usado para criar se não existir)" },
            domain: { type: "string", description: "(Opcional) Domínio/site (ex: empresa.com)" },
            owner_id: { type: "integer", description: "(Obrigatório para criar) ID do responsável" },
            email: { type: "string", description: "(Opcional) Email" },
            phone: { type: "string", description: "(Opcional) Telefone" },
            max_pages: { type: "integer", description: "(Opcional) Máx páginas para busca (padrão 5, máx 20)" },
            show: { type: "integer", description: "(Opcional) Itens por página (padrão 200, máx 200)" }
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "route_lead_to_owner",
        description: "Escolhe determinísticamente um owner_id a partir de uma chave (email/telefone/domínio) e uma lista de candidatos.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            key: { type: "string", description: "Chave de roteamento (ex: email/domínio)" },
            candidates_owner_ids: {
              type: "array",
              items: { type: "integer" },
              description: "Lista de IDs de vendedores elegíveis"
            }
          },
          required: ["key", "candidates_owner_ids"],
          additionalProperties: false,
        },
      },
      {
        name: "assign_deal_owner",
        description: "Define/atualiza o owner_id de uma oportunidade (deal).",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
            owner_id: { type: "integer", description: "ID do responsável" }
          },
          required: ["deal_id", "owner_id"],
          additionalProperties: false,
        },
      },
      {
        name: "create_meeting_activity_for_deal",
        description: "Cria uma atividade do tipo Reunião vinculada a uma oportunidade (deal).",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            deal_id: { type: "integer", description: "ID da oportunidade" },
            title: { type: "string", description: "Título da reunião" },
            owner_id: { type: "integer", description: "(Opcional) ID do responsável" },
            start_at: { type: "string", format: "date-time", description: "(Opcional) Início (date-time)" },
            end_at: { type: "string", format: "date-time", description: "(Opcional) Fim (date-time)" },
            description: { type: "string", description: "(Opcional) Descrição" },
            status: { type: "integer", description: "(Opcional) Status (default 0=Aberta)" },
            activity_type_id: { type: "integer", description: "(Opcional) ID do tipo (default: Reunião)" }
          },
          required: ["deal_id", "title"],
          additionalProperties: false,
        },
      },
      {
        name: "create_opportunity_bundle",
        description: "Cria oportunidade (deal) + (opcional) upsert de pessoa/empresa + nota do scraping.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            // deal
            title: { type: "string", description: "Título da oportunidade" },
            pipeline_id: { type: "integer", description: "ID do funil" },
            stage_id: { type: "integer", description: "ID da etapa" },
            value: { type: "number", description: "(Opcional) Valor" },
            owner_id: { type: "integer", description: "(Opcional) Owner do deal" },
            // person
            person_id: { type: "integer", description: "(Opcional) ID da pessoa (se já existir)" },
            person_name: { type: "string", description: "(Opcional) Nome da pessoa (para upsert/criar)" },
            person_owner_id: { type: "integer", description: "(Opcional) Owner da pessoa (necessário se for criar)" },
            person_email: { type: "string", description: "(Opcional) Email da pessoa" },
            person_phone: { type: "string", description: "(Opcional) Telefone da pessoa" },
            // company
            company_id: { type: "integer", description: "(Opcional) ID da empresa (se já existir)" },
            company_name: { type: "string", description: "(Opcional) Nome da empresa (para upsert/criar)" },
            company_owner_id: { type: "integer", description: "(Opcional) Owner da empresa (necessário se for criar)" },
            company_domain: { type: "string", description: "(Opcional) Domínio/site" },
            company_email: { type: "string", description: "(Opcional) Email da empresa" },
            company_phone: { type: "string", description: "(Opcional) Telefone da empresa" },
            // note
            note_content: { type: "string", description: "(Opcional) Nota (ex: resumo do scraping)" },
            // search controls
            max_pages: { type: "integer", description: "(Opcional) Máx páginas para busca (padrão 5, máx 20)" },
            show: { type: "integer", description: "(Opcional) Itens por página (padrão 200, máx 200)" }
          },
          required: ["title", "pipeline_id", "stage_id"],
          additionalProperties: false,
        },
      },
      {
        name: "log_outbound_call_and_outcome",
        description: "Registra histórico de ligação (calls) e cria nota. Opcionalmente cria follow-up activity.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            call_body: { type: "object", description: "(Opcional) Body para POST /calls", additionalProperties: true },
            note_content: { type: "string", description: "(Obrigatório) Conteúdo da nota (resultado da ligação)" },
            deal_id: { type: "integer", description: "(Opcional) ID do deal" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" },
            followup: {
              type: "object",
              description: "(Opcional) Se presente, cria uma activity de follow-up",
              properties: {
                title: { type: "string" },
                owner_id: { type: "integer" },
                start_at: { type: "string", format: "date-time" },
                end_at: { type: "string", format: "date-time" },
                description: { type: "string" },
                status: { type: "integer" },
                activity_type_id: { type: "integer", description: "(Opcional) default: Ligação" }
              },
              required: ["title"],
              additionalProperties: false
            }
          },
          required: ["note_content"],
          additionalProperties: false,
        },
      },
      {
        name: "complete_activity_with_notes",
        description: "Conclui uma activity (status=2) e opcionalmente cria uma nota vinculada.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: { type: "string", description: "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente." },
            activity_id: { type: "integer", description: "ID da atividade" },
            note_content: { type: "string", description: "(Opcional) Conteúdo da nota" },
            deal_id: { type: "integer", description: "(Opcional) ID do deal" },
            person_id: { type: "integer", description: "(Opcional) ID da pessoa" },
            company_id: { type: "integer", description: "(Opcional) ID da empresa" }
          },
          required: ["activity_id"],
          additionalProperties: false,
        },
      },
      {
        name: "revops_intake",
        description:
          "Super-tool de intake RevOps: usa dados de scraping/ligação para (1) upsert pessoa/empresa, (2) criar oportunidade, (3) registrar nota/outcome e (4) opcionalmente criar reunião e atribuir vendedor.",
        inputSchema: {
          type: "object",
          properties: {
            api_token: {
              type: "string",
              description:
                "(Opcional) Token da API do PipeRun. Se omitido, usa PIPERUN_API_TOKEN do ambiente.",
            },

            // routing / ownership
            candidates_owner_ids: {
              type: "array",
              items: { type: "integer" },
              description:
                "(Opcional) Lista de owners elegíveis. Se informado e owner não vier explícito, o tool escolhe determinísticamente (hash) a partir de uma chave (email/telefone/domínio).",
            },
            routing_key: {
              type: "string",
              description:
                "(Opcional) Chave de roteamento. Se omitida, usa person_email || person_phone || company_domain || company_name.",
            },

            // deal (obrigatório)
            title: { type: "string", description: "Título da oportunidade" },
            pipeline_id: { type: "integer", description: "(Obrigatório) ID do funil" },
            stage_id: { type: "integer", description: "(Obrigatório) ID da etapa" },
            value: { type: "number", description: "(Opcional) Valor" },
            deal_owner_id: {
              type: "integer",
              description:
                "(Opcional) Owner do deal. Se omitido e candidates_owner_ids for informado, será escolhido automaticamente.",
            },

            // person
            person_id: { type: "integer", description: "(Opcional) ID da pessoa (se já existir)" },
            person_name: {
              type: "string",
              description:
                "(Opcional) Nome da pessoa (para upsert/criar). Se pessoa não existir, este campo é obrigatório para criar.",
            },
            person_email: { type: "string", description: "(Opcional) Email" },
            person_phone: { type: "string", description: "(Opcional) Telefone" },
            person_owner_id: {
              type: "integer",
              description:
                "(Opcional) Owner da pessoa. Se omitido e candidates_owner_ids for informado, será escolhido automaticamente para criação.",
            },

            // company
            company_id: { type: "integer", description: "(Opcional) ID da empresa (se já existir)" },
            company_name: {
              type: "string",
              description:
                "(Opcional) Nome da empresa (para upsert/criar). Se empresa não existir, este campo é obrigatório para criar.",
            },
            company_domain: { type: "string", description: "(Opcional) Domínio/site (ex: empresa.com)" },
            company_email: { type: "string", description: "(Opcional) Email" },
            company_phone: { type: "string", description: "(Opcional) Telefone" },
            company_owner_id: {
              type: "integer",
              description:
                "(Opcional) Owner da empresa. Se omitido e candidates_owner_ids for informado, será escolhido automaticamente para criação.",
            },

            // context / notes
            note_content: {
              type: "string",
              description:
                "(Opcional) Nota consolidada (ex: resumo do scraping, motivo do contato, etc).",
            },
            call_outcome: {
              type: "string",
              description:
                "(Opcional) Outcome da ligação (ex: 'agendou', 'não atendeu', 'follow-up', etc).",
            },
            call_body: {
              type: "object",
              description: "(Opcional) Body bruto para POST /calls",
              additionalProperties: true,
            },

            // meeting
            meeting: {
              type: "object",
              description:
                "(Opcional) Se presente, cria uma activity do tipo Reunião vinculada ao deal criado.",
              properties: {
                title: { type: "string" },
                owner_id: { type: "integer" },
                start_at: { type: "string", format: "date-time" },
                end_at: { type: "string", format: "date-time" },
                description: { type: "string" },
                status: { type: "integer" },
                activity_type_id: { type: "integer" },
              },
              required: ["title"],
              additionalProperties: false,
            },

            // follow-up activity
            followup: {
              type: "object",
              description:
                "(Opcional) Se presente, cria uma activity de follow-up (default: Ligação) vinculada ao deal.",
              properties: {
                title: { type: "string" },
                owner_id: { type: "integer" },
                start_at: { type: "string", format: "date-time" },
                end_at: { type: "string", format: "date-time" },
                description: { type: "string" },
                status: { type: "integer" },
                activity_type_id: { type: "integer" },
              },
              required: ["title"],
              additionalProperties: false,
            },

            // search controls
            max_pages: { type: "integer", description: "(Opcional) Máx páginas para busca (padrão 5, máx 20)" },
            show: { type: "integer", description: "(Opcional) Itens por página (padrão 200, máx 200)" },
          },
          required: ["title", "pipeline_id", "stage_id"],
          additionalProperties: false,
        },
      },
    ],
  };
});

// 5. Handler para chamar as ferramentas
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  let name = "";
  try {
    name = request.params.name;
    const args = request.params.arguments;

    const api_token = resolveApiToken(args);

    // toolArgs: copia args (se existir) e remove api_token
    const toolArgs: Record<string, any> =
      args && typeof args === "object" ? { ...(args as any) } : {};
    delete toolArgs.api_token;

    // Normaliza campos numéricos que podem vir como string (ex: "94766")
    for (const [key, value] of Object.entries(toolArgs)) {
      if (key.endsWith("_id") || key === "page" || key === "show" || key === "status") {
        if (
          typeof value === "string" &&
          value.trim() !== "" &&
          !Number.isNaN(Number(value))
        ) {
          toolArgs[key] = Number(value);
        }
      }
    }


    const requestHeaders = {
      token: api_token,
      "Content-Type": "application/json",
    };

    switch (name) {
      case "piperun_request": {
        if (!toolArgs || typeof toolArgs !== "object") {
          throw new McpError(ErrorCode.InvalidParams, "Argumentos inválidos.");
        }

        const methodRaw = toolArgs.method;
        const pathRaw = toolArgs.path;
        const query = toolArgs.query;
        const body = toolArgs.body;

        if (!methodRaw || !pathRaw) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "piperun_request exige 'method' e 'path'."
          );
        }

        const method = String(methodRaw).toUpperCase();
        if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "method inválido. Use GET | POST | PUT | DELETE."
          );
        }

        // Segurança: impedir URL absoluta (axios ignora baseURL se receber URL absoluta)
        const pathStr = String(pathRaw).trim();
        if (pathStr.startsWith("//") || pathStr.includes("://")) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "path inválido. Use apenas caminhos relativos a /v1 (ex: /deals, /me)."
          );
        }

        // Normaliza path: garante '/' e remove prefixo '/v1' se o usuário passar
        let normalizedPath = pathStr.startsWith("/") ? pathStr : `/${pathStr}`;
        if (normalizedPath.startsWith("/v1/")) normalizedPath = normalizedPath.slice(3);
        if (normalizedPath === "/v1") normalizedPath = "/";

        const response = await axiosInstance.request({
          method,
          url: normalizedPath, // axiosInstance já tem baseURL /v1
          params: query,
          data: body,
          headers: requestHeaders,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "get_deal":
      case "get_opportunity": {
        if (typeof toolArgs.deal_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'deal_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.get(`/deals/${toolArgs.deal_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "create_deal":
      case "create_opportunity": {
        if (typeof toolArgs.title !== "string" || !toolArgs.title.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "O campo 'title' (string) é obrigatório.");
        }
        if (typeof toolArgs.pipeline_id !== "number") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "O campo 'pipeline_id' (number) é obrigatório."
          );
        }
        if (typeof toolArgs.stage_id !== "number") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "O campo 'stage_id' (number) é obrigatório."
          );
        }

        const response = await axiosInstance.post("/deals", toolArgs, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "update_deal":
      case "update_opportunity": {
        if (typeof toolArgs.deal_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'deal_id' (number) é obrigatório.");
        }
        const deal_id = toolArgs.deal_id;
        const updateData = { ...toolArgs };
        delete updateData.deal_id;

        if (Object.keys(updateData).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Nenhum dado fornecido para atualizar (além do deal_id).");
        }

        const response = await axiosInstance.put(`/deals/${deal_id}`, updateData, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "delete_deal":
      case "delete_opportunity": {
        if (typeof toolArgs.deal_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'deal_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.delete(`/deals/${toolArgs.deal_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      // People/Notes CRUD handlers
      case "get_person": {
        if (typeof toolArgs.person_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'person_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.get(`/persons/${toolArgs.person_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "update_person": {
        if (typeof toolArgs.person_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'person_id' (number) é obrigatório.");
        }
        const person_id = toolArgs.person_id;
        const updateData = { ...toolArgs };
        delete updateData.person_id;

        if (Object.keys(updateData).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Nenhum dado fornecido para atualizar (além do person_id)." );
        }

        const response = await axiosInstance.put(`/persons/${person_id}`, updateData, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "delete_person": {
        if (typeof toolArgs.person_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'person_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.delete(`/persons/${toolArgs.person_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "get_note": {
        if (typeof toolArgs.note_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'note_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.get(`/notes/${toolArgs.note_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "update_note": {
        if (typeof toolArgs.note_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'note_id' (number) é obrigatório.");
        }
        const note_id = toolArgs.note_id;
        const updateData = { ...toolArgs };
        delete updateData.note_id;

        if (Object.keys(updateData).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Nenhum dado fornecido para atualizar (além do note_id)." );
        }

        const response = await axiosInstance.put(`/notes/${note_id}`, updateData, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "delete_note": {
        if (typeof toolArgs.note_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'note_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.delete(`/notes/${toolArgs.note_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "get_activity": {
        if (typeof toolArgs.activity_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'activity_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.get(`/activities/${toolArgs.activity_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "create_activity": {
        if (typeof toolArgs.title !== "string" || !toolArgs.title.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "O campo 'title' (string) é obrigatório.");
        }
        if (typeof toolArgs.activity_type_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O campo 'activity_type_id' (number) é obrigatório.");
        }
        if (typeof toolArgs.status !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O campo 'status' (number) é obrigatório.");
        }
        const activityPayload: any = { ...toolArgs };
        if (typeof activityPayload.start_at === "string" && activityPayload.start_at.trim()) {
          activityPayload.start_at = formatDateToYmd(activityPayload.start_at);
        }
        if (typeof activityPayload.end_at === "string" && activityPayload.end_at.trim()) {
          activityPayload.end_at = formatDateToYmd(activityPayload.end_at);
        }

        const response = await axiosInstance.post("/activities", activityPayload, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "update_activity": {
        if (typeof toolArgs.activity_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'activity_id' (number) é obrigatório.");
        }
        const activity_id = toolArgs.activity_id;
        const updateData = { ...toolArgs };
        delete updateData.activity_id;

        if (Object.keys(updateData).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Nenhum dado fornecido para atualizar (além do activity_id).");
        }

        if (typeof updateData.start_at === "string" && updateData.start_at.trim()) {
          updateData.start_at = formatDateToYmd(updateData.start_at);
        }
        if (typeof updateData.end_at === "string" && updateData.end_at.trim()) {
          updateData.end_at = formatDateToYmd(updateData.end_at);
        }

        const response = await axiosInstance.put(`/activities/${activity_id}`, updateData, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "delete_activity": {
        if (typeof toolArgs.activity_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'activity_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.delete(`/activities/${toolArgs.activity_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "get_call": {
        if (typeof toolArgs.call_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'call_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.get(`/calls/${toolArgs.call_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "create_call": {
        const response = await axiosInstance.post("/calls", toolArgs, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "update_call": {
        if (typeof toolArgs.call_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'call_id' (number) é obrigatório.");
        }
        const call_id = toolArgs.call_id;
        const updateData = { ...toolArgs };
        delete updateData.call_id;

        if (Object.keys(updateData).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Nenhum dado fornecido para atualizar (além do call_id).");
        }

        const response = await axiosInstance.put(`/calls/${call_id}`, updateData, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "delete_call": {
        if (typeof toolArgs.call_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'call_id' (number) é obrigatório.");
        }
        const response = await axiosInstance.delete(`/calls/${toolArgs.call_id}`, {
          headers: requestHeaders,
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }


      case "list_deals":
      case "list_opportunities": {
        const response = await axiosInstance.get("/deals", {
          params: toolArgs,
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "create_person": {
        if (!isValidCreatePersonArgs(toolArgs)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Argumentos inválidos para create_person. 'name' (string) e 'owner_id' (number) são obrigatórios."
          );
        }

        const payload: Record<string, any> = { ...toolArgs };
        payload.name = toolArgs.name.trim();
        payload.owner_id = toolArgs.owner_id;
        if (typeof payload.email === "string") payload.email = payload.email.trim();
        if (typeof payload.phone === "string") payload.phone = payload.phone.trim();

        const response = await axiosInstance.post("/persons", payload, {
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      // Listagens genéricas
      case "list_pipelines":
      case "list_calls":
      case "list_stages":
      case "list_items":
      case "list_users":
      case "list_activities":
      case "list_companies":
      case "list_tags":
      case "list_loss_reasons":
      case "list_deal_sources":
      case "list_activity_types":
      case "list_custom_fields":
      case "list_notes":
      case "list_persons": {
        let endpoint = "";
        switch (name) {
          case "list_pipelines": endpoint = "/pipelines"; break;
          case "list_calls": endpoint = "/calls"; break;
          case "list_stages": endpoint = "/stages"; break;
          case "list_items": endpoint = "/items"; break;
          case "list_users": endpoint = "/users"; break;
          case "list_activities": endpoint = "/activities"; break;
          case "list_companies": endpoint = "/companies"; break;
          case "list_tags": endpoint = "/tags"; break;
          case "list_loss_reasons": endpoint = "/loss-reasons"; break;
          case "list_deal_sources": endpoint = "/deal-sources"; break;
          case "list_activity_types": endpoint = "/activityTypes"; break;
          case "list_custom_fields": endpoint = "/customFields"; break;
          case "list_notes": endpoint = "/notes"; break;
          case "list_persons": endpoint = "/persons"; break;
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Mapeamento de endpoint não encontrado para: ${name}`
            );
        }
        const response = await axiosInstance.get(endpoint, {
          params: toolArgs,
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "get_company": {
        if (typeof toolArgs.company_id !== "number") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "O parâmetro 'company_id' (number) é obrigatório para get_company."
          );
        }
        const company_id = toolArgs.company_id;
        const queryArgs = { ...toolArgs };
        delete queryArgs.company_id;

        const response = await axiosInstance.get(`/companies/${company_id}`, {
          params: queryArgs,
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "create_company": {
        if (typeof toolArgs.name !== "string" || !toolArgs.name.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "O campo 'name' (string) é obrigatório.");
        }
        if (typeof toolArgs.owner_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O campo 'owner_id' (number) é obrigatório.");
        }

        const payload: Record<string, any> = { ...toolArgs };
        payload.name = toolArgs.name.trim();
        if (typeof payload.email === "string") payload.email = payload.email.trim();
        if (typeof payload.phone === "string") payload.phone = payload.phone.trim();

        const response = await axiosInstance.post("/companies", payload, {
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "update_company": {
        if (typeof toolArgs.company_id !== "number") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "O parâmetro 'company_id' (number) é obrigatório para update_company."
          );
        }
        const company_id = toolArgs.company_id;
        const updateData = { ...toolArgs };
        delete updateData.company_id;

        if (Object.keys(updateData).length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Nenhum dado fornecido para atualizar a empresa (além do company_id)."
          );
        }

        const response = await axiosInstance.put(`/companies/${company_id}`, updateData, {
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "create_note": {
        if (!isValidCreateNoteArgs(toolArgs)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Argumentos inválidos para create_note. 'content' (string) e pelo menos um ID ('deal_id', 'person_id', ou 'company_id') são obrigatórios."
          );
        }
        const response = await axiosInstance.post("/notes", toolArgs, {
          headers: requestHeaders,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case "route_lead_to_owner": {
        if (typeof toolArgs.key !== "string" || !toolArgs.key.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'key' (string) é obrigatório.");
        }
        if (!Array.isArray(toolArgs.candidates_owner_ids) || toolArgs.candidates_owner_ids.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "O parâmetro 'candidates_owner_ids' (array de integers) é obrigatório e não pode ser vazio."
          );
        }

        const candidates = (toolArgs.candidates_owner_ids as any[])
          .map((x) => {
            if (typeof x === "number") return x;
            if (typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x))) return Number(x);
            return null;
          })
          .filter((x): x is number => typeof x === "number");
        if (candidates.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'candidates_owner_ids' deve conter ao menos um number válido.");
        }

        const key = toolArgs.key.trim();
        const idx = stableHash(key) % candidates.length;
        const owner_id = candidates[idx];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  key,
                  owner_id,
                  index: idx,
                  candidates_owner_ids: candidates,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "assign_deal_owner": {
        if (typeof toolArgs.deal_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'deal_id' (number) é obrigatório.");
        }
        if (typeof toolArgs.owner_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'owner_id' (number) é obrigatório.");
        }

        const response = await axiosInstance.put(
          `/deals/${toolArgs.deal_id}`,
          { owner_id: toolArgs.owner_id },
          { headers: requestHeaders }
        );

        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "resolve_deal_owner": {
        // Retorna dados enriquecidos do deal/pipeline/owner a partir de ids ou nomes
        const dealIdIn = typeof toolArgs.deal_id === "number" ? toolArgs.deal_id : undefined;
        const dealTitleIn = typeof toolArgs.deal_title === "string" && toolArgs.deal_title.trim() ? toolArgs.deal_title.trim() : undefined;
        const pipelineIdIn = typeof toolArgs.pipeline_id === "number" ? toolArgs.pipeline_id : undefined;
        const pipelineNameIn = typeof toolArgs.pipeline_name === "string" && toolArgs.pipeline_name.trim() ? toolArgs.pipeline_name.trim() : undefined;
        const ownerIdIn = typeof toolArgs.owner_id === "number" ? toolArgs.owner_id : undefined;
        const ownerNameIn = typeof toolArgs.owner_name === "string" && toolArgs.owner_name.trim() ? toolArgs.owner_name.trim() : undefined;

        // Helpers to fetch lists
        const pipelines = await listAllPages<any>({ endpoint: "/pipelines", params: {}, headers: requestHeaders, maxPages: 5, show: 200 });
        const users = await listAllPages<any>({ endpoint: "/users", params: {}, headers: requestHeaders, maxPages: 5, show: 200 });

        // Resolve pipeline id/name
        let pipelineId: number | undefined = pipelineIdIn;
        let pipelineName: string | undefined = pipelineNameIn;
        if (!pipelineId && pipelineNameIn) {
          const found = pipelines.find((p) => (p?.name || "").toString().trim().toLowerCase() === pipelineNameIn.toLowerCase());
          if (found && typeof found.id === "number") pipelineId = found.id;
        }
        if (!pipelineName && pipelineId) {
          const found = pipelines.find((p) => p?.id === pipelineId);
          if (found) pipelineName = String(found.name || "").trim();
        }

        // Resolve owner id/name
        let ownerId: number | undefined = ownerIdIn;
        let ownerName: string | undefined = ownerNameIn;
        if (!ownerId && ownerNameIn) {
          const found = users.find((u) => ((u?.name || "") as string).toLowerCase().trim() === ownerNameIn.toLowerCase());
          if (found && typeof found.id === "number") ownerId = found.id;
        }
        if (!ownerName && ownerId) {
          const found = users.find((u) => u?.id === ownerId);
          if (found) ownerName = String(found.name || "").trim();
        }

        // Resolve deal
        let deal: any = null;
        if (typeof dealId === "number") {
          const resp = await axiosInstance.get(`/deals/${dealId}`, { headers: requestHeaders });
          deal = (resp.data as any)?.data ?? resp.data;
        } else if (dealTitleIn) {
          // list deals and find best match by title
          const deals = await listAllPages<any>({ endpoint: "/deals", params: {}, headers: requestHeaders, maxPages: 5, show: 200 });
          const titleLower = dealTitleIn.toLowerCase();
          let found = deals.find((d) => ((d?.title || "") as string).toLowerCase().trim() === titleLower);
          if (!found) found = deals.find((d) => ((d?.title || "") as string).toLowerCase().includes(titleLower));
          if (!found && pipelineId) {
            found = deals.find((d) => d?.pipeline_id === pipelineId && ((d?.title || "") as string).toLowerCase().includes(titleLower));
          }
          if (found) deal = found;
          // otherwise as fallback, if ownerId provided, pick most recent deal for that owner
          if (!deal && ownerId) {
            const deals = await listAllPages<any>({ endpoint: "/deals", params: {}, headers: requestHeaders, maxPages: 5, show: 200 });
            const foundByOwner = deals.find((d) => d?.owner_id === ownerId);
            if (foundByOwner) deal = foundByOwner;
          }
        } else if (pipelineId) {
          // pick most recent deal in pipeline
          const deals = await listAllPages<any>({ endpoint: "/deals", params: { pipeline_id: pipelineId }, headers: requestHeaders, maxPages: 5, show: 200 });
          if (deals.length > 0) deal = deals[0];
        } else if (ownerId) {
          const deals = await listAllPages<any>({ endpoint: "/deals", params: {}, headers: requestHeaders, maxPages: 5, show: 200 });
          const found = deals.find((d) => d?.owner_id === ownerId);
          if (found) deal = found;
        }

        if (!deal) {
          throw new McpError(ErrorCode.InvalidParams, "Não foi possível localizar uma oportunidade com os parâmetros fornecidos.");
        }

        // Enriquecer com pipeline/owner names se possível
        const resolvedDeal = {
          id: deal.id ?? dealIdIn,
          title: deal.title ?? deal?.name ?? null,
          pipeline_id: deal.pipeline_id ?? pipelineId ?? null,
          owner_id: deal.owner_id ?? ownerId ?? null,
        };

        if (!pipelineName && resolvedDeal.pipeline_id) {
          const p = pipelines.find((x) => x?.id === resolvedDeal.pipeline_id);
          if (p) pipelineName = String(p.name || "").trim();
        }
        if (!ownerName && resolvedDeal.owner_id) {
          const u = users.find((x) => x?.id === resolvedDeal.owner_id);
          if (u) ownerName = String(u.name || "").trim();
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  deal: resolvedDeal,
                  pipeline: { id: resolvedDeal.pipeline_id ?? null, name: pipelineName ?? null },
                  owner: { id: resolvedDeal.owner_id ?? null, name: ownerName ?? null },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "upsert_company_by_domain_or_name": {
        const maxPages = typeof toolArgs.max_pages === "number" ? toolArgs.max_pages : 5;
        const show = typeof toolArgs.show === "number" ? toolArgs.show : 200;

        const nameIn = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
        const domainIn = typeof toolArgs.domain === "string" ? toolArgs.domain.trim() : "";

        if (!nameIn && !domainIn) {
          throw new McpError(ErrorCode.InvalidParams, "Informe 'name' e/ou 'domain' para buscar empresa.");
        }

        const companies = await listAllPages<any>({
          endpoint: "/companies",
          params: {},
          headers: requestHeaders,
          maxPages,
          show,
        });

        const found = companies.find((c) => findCompanyMatch(c, domainIn || undefined, nameIn || undefined));
        if (found && typeof (found as any)?.id === "number") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ action: "matched", company: found }, null, 2),
              },
            ],
          };
        }

        if (!nameIn) {
          throw new McpError(ErrorCode.InvalidParams, "Empresa não encontrada. Para criar, informe 'name'.");
        }
        if (typeof toolArgs.owner_id !== "number") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Empresa não encontrada. Para criar, informe 'owner_id' (number)."
          );
        }

        const payload: any = { name: nameIn, owner_id: toolArgs.owner_id };
        if (typeof toolArgs.email === "string" && toolArgs.email.trim()) payload.email = toolArgs.email.trim();
        if (typeof toolArgs.phone === "string" && toolArgs.phone.trim()) payload.phone = toolArgs.phone.trim();
        if (domainIn) payload.website = domainIn;

        const created = await axiosInstance.post("/companies", payload, { headers: requestHeaders });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ action: "created", company: created.data }, null, 2),
            },
          ],
        };
      }

      case "upsert_person_by_email_or_phone": {
        const maxPages = typeof toolArgs.max_pages === "number" ? toolArgs.max_pages : 5;
        const show = typeof toolArgs.show === "number" ? toolArgs.show : 200;

        const nameIn = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
        const emailIn = typeof toolArgs.email === "string" ? toolArgs.email.trim() : "";
        const phoneIn = typeof toolArgs.phone === "string" ? toolArgs.phone.trim() : "";

        if (!emailIn && !phoneIn && !nameIn) {
          throw new McpError(ErrorCode.InvalidParams, "Informe ao menos 'email', 'phone' ou 'name' para buscar pessoa.");
        }

        const persons = await listAllPages<any>({
          endpoint: "/persons",
          params: {},
          headers: requestHeaders,
          maxPages,
          show,
        });

        const found = persons.find((p) => findPersonMatch(p, emailIn || undefined, phoneIn || undefined));
        if (found && typeof (found as any)?.id === "number") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ action: "matched", person: found }, null, 2),
              },
            ],
          };
        }

        if (!nameIn) {
          throw new McpError(ErrorCode.InvalidParams, "Pessoa não encontrada. Para criar, informe 'name'.");
        }
        if (typeof toolArgs.owner_id !== "number") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Pessoa não encontrada. Para criar, informe 'owner_id' (number)."
          );
        }

        const payload: any = { name: nameIn, owner_id: toolArgs.owner_id };
        if (emailIn) payload.email = emailIn;
        if (phoneIn) payload.phone = phoneIn;
        if (typeof toolArgs.company_id === "number") payload.company_id = toolArgs.company_id;

        const created = await axiosInstance.post("/persons", payload, { headers: requestHeaders });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ action: "created", person: created.data }, null, 2),
            },
          ],
        };
      }

      case "create_meeting_activity_for_deal": {
        if (typeof toolArgs.deal_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'deal_id' (number) é obrigatório.");
        }
        if (typeof toolArgs.title !== "string" || !toolArgs.title.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'title' (string) é obrigatório.");
        }

        const payload: any = {
          title: toolArgs.title.trim(),
          deal_id: toolArgs.deal_id,
          activity_type_id:
            typeof toolArgs.activity_type_id === "number" ? toolArgs.activity_type_id : ACTIVITY_TYPE_MEETING_ID_DEFAULT,
          status: typeof toolArgs.status === "number" ? toolArgs.status : 0,
        };
        if (typeof toolArgs.owner_id === "number") payload.owner_id = toolArgs.owner_id;
        if (typeof toolArgs.start_at === "string" && toolArgs.start_at.trim()) payload.start_at = formatDateToYmd(toolArgs.start_at);
        if (typeof toolArgs.end_at === "string" && toolArgs.end_at.trim()) payload.end_at = formatDateToYmd(toolArgs.end_at);
        if (typeof toolArgs.description === "string") payload.description = toolArgs.description;

        const response = await axiosInstance.post("/activities", payload, { headers: requestHeaders });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
      }

      case "create_opportunity_bundle": {
        // Deal obrigatório
        if (typeof toolArgs.title !== "string" || !toolArgs.title.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "'title' (string) é obrigatório.");
        }
        if (typeof toolArgs.pipeline_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "'pipeline_id' (number) é obrigatório.");
        }
        if (typeof toolArgs.stage_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "'stage_id' (number) é obrigatório.");
        }

        const maxPages = typeof toolArgs.max_pages === "number" ? toolArgs.max_pages : 5;
        const show = typeof toolArgs.show === "number" ? toolArgs.show : 200;

        // Company upsert (optional)
        let companyId: number | undefined = typeof toolArgs.company_id === "number" ? toolArgs.company_id : undefined;
        let companyResult: any = null;

        const companyName = typeof toolArgs.company_name === "string" ? toolArgs.company_name.trim() : "";
        const companyDomain = typeof toolArgs.company_domain === "string" ? toolArgs.company_domain.trim() : "";

        if (!companyId && (companyName || companyDomain)) {
          const companies = await listAllPages<any>({
            endpoint: "/companies",
            params: {},
            headers: requestHeaders,
            maxPages,
            show,
          });

          const foundCompany = companies.find((c) => findCompanyMatch(c, companyDomain || undefined, companyName || undefined));
          if (foundCompany && typeof (foundCompany as any)?.id === "number") {
            companyId = (foundCompany as any).id;
            companyResult = { action: "matched", company: foundCompany };
          } else {
            if (!companyName) {
              throw new McpError(ErrorCode.InvalidParams, "Empresa não encontrada. Para criar, informe 'company_name'.");
            }
            if (typeof toolArgs.company_owner_id !== "number") {
              throw new McpError(ErrorCode.InvalidParams, "Empresa não encontrada. Para criar, informe 'company_owner_id'.");
            }

            const payload: any = { name: companyName, owner_id: toolArgs.company_owner_id };
            if (typeof toolArgs.company_email === "string" && toolArgs.company_email.trim()) payload.email = toolArgs.company_email.trim();
            if (typeof toolArgs.company_phone === "string" && toolArgs.company_phone.trim()) payload.phone = toolArgs.company_phone.trim();
            if (companyDomain) payload.website = companyDomain;

            const createdCompany = await axiosInstance.post("/companies", payload, { headers: requestHeaders });
            const createdCompanyId = (createdCompany.data as any)?.data?.id ?? (createdCompany.data as any)?.id;
            if (typeof createdCompanyId === "number") companyId = createdCompanyId;
            companyResult = { action: "created", company: createdCompany.data };
          }
        }

        // Person upsert (optional)
        let personId: number | undefined = typeof toolArgs.person_id === "number" ? toolArgs.person_id : undefined;
        let personResult: any = null;

        const personName = typeof toolArgs.person_name === "string" ? toolArgs.person_name.trim() : "";
        const personEmail = typeof toolArgs.person_email === "string" ? toolArgs.person_email.trim() : "";
        const personPhone = typeof toolArgs.person_phone === "string" ? toolArgs.person_phone.trim() : "";

        if (!personId && (personName || personEmail || personPhone)) {
          const persons = await listAllPages<any>({
            endpoint: "/persons",
            params: {},
            headers: requestHeaders,
            maxPages,
            show,
          });

          const foundPerson = persons.find((p) => findPersonMatch(p, personEmail || undefined, personPhone || undefined));
          if (foundPerson && typeof (foundPerson as any)?.id === "number") {
            personId = (foundPerson as any).id;
            personResult = { action: "matched", person: foundPerson };
          } else {
            if (!personName) {
              throw new McpError(ErrorCode.InvalidParams, "Pessoa não encontrada. Para criar, informe 'person_name'.");
            }
            if (typeof toolArgs.person_owner_id !== "number") {
              throw new McpError(ErrorCode.InvalidParams, "Pessoa não encontrada. Para criar, informe 'person_owner_id'.");
            }

            const payload: any = { name: personName, owner_id: toolArgs.person_owner_id };
            if (personEmail) payload.email = personEmail;
            if (personPhone) payload.phone = personPhone;
            if (companyId) payload.company_id = companyId;

            const createdPerson = await axiosInstance.post("/persons", payload, { headers: requestHeaders });
            const createdPersonId = (createdPerson.data as any)?.data?.id ?? (createdPerson.data as any)?.id;
            if (typeof createdPersonId === "number") personId = createdPersonId;
            personResult = { action: "created", person: createdPerson.data };
          }
        }

        // Create deal
        const dealPayload: any = {
          title: toolArgs.title.trim(),
          pipeline_id: toolArgs.pipeline_id,
          stage_id: toolArgs.stage_id,
        };
        if (typeof toolArgs.value === "number") dealPayload.value = toolArgs.value;
        if (typeof toolArgs.owner_id === "number") dealPayload.owner_id = toolArgs.owner_id;
        if (personId) dealPayload.person_id = personId;
        if (companyId) dealPayload.company_id = companyId;

        const createdDeal = await axiosInstance.post("/deals", dealPayload, { headers: requestHeaders });
        const dealId = (createdDeal.data as any)?.data?.id ?? (createdDeal.data as any)?.id;

        // Note (optional)
        let createdNote: any = null;
        if (typeof toolArgs.note_content === "string" && toolArgs.note_content.trim() && typeof dealId === "number") {
          createdNote = (
            await axiosInstance.post(
              "/notes",
              { content: toolArgs.note_content.trim(), deal_id: dealId },
              { headers: requestHeaders }
            )
          ).data;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  company: companyResult,
                  person: personResult,
                  deal: createdDeal.data,
                  deal_id: dealId,
                  note: createdNote,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "log_outbound_call_and_outcome": {
        // 1) optional call
        let createdCall: any = null;
        if (toolArgs.call_body && typeof toolArgs.call_body === "object") {
          createdCall = (await axiosInstance.post("/calls", toolArgs.call_body, { headers: requestHeaders })).data;
        }

        // 2) note is required by schema
        if (typeof toolArgs.note_content !== "string" || !toolArgs.note_content.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "'note_content' (string) é obrigatório.");
        }

        const notePayload: any = { content: toolArgs.note_content.trim() };
        if (typeof toolArgs.deal_id === "number") notePayload.deal_id = toolArgs.deal_id;
        else if (typeof toolArgs.person_id === "number") notePayload.person_id = toolArgs.person_id;
        else if (typeof toolArgs.company_id === "number") notePayload.company_id = toolArgs.company_id;
        else {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Para criar nota, informe um vínculo: 'deal_id' ou 'person_id' ou 'company_id'."
          );
        }

        const createdNote = (await axiosInstance.post("/notes", notePayload, { headers: requestHeaders })).data;

        // 3) optional follow-up activity
        let createdFollowup: any = null;
        if (toolArgs.followup && typeof toolArgs.followup === "object") {
          const f = toolArgs.followup as any;
          if (typeof f.title !== "string" || !f.title.trim()) {
            throw new McpError(ErrorCode.InvalidParams, "followup.title (string) é obrigatório.");
          }

          const activityPayload: any = {
            title: f.title.trim(),
            activity_type_id: typeof f.activity_type_id === "number" ? f.activity_type_id : ACTIVITY_TYPE_CALL_ID_DEFAULT,
            status: typeof f.status === "number" ? f.status : 0,
          };
          if (typeof f.owner_id === "number") activityPayload.owner_id = f.owner_id;
          if (typeof f.start_at === "string" && f.start_at.trim()) activityPayload.start_at = formatDateToYmd(f.start_at);
          if (typeof f.end_at === "string" && f.end_at.trim()) activityPayload.end_at = formatDateToYmd(f.end_at);
          if (typeof f.description === "string") activityPayload.description = f.description;

          if (typeof toolArgs.deal_id === "number") activityPayload.deal_id = toolArgs.deal_id;
          if (typeof toolArgs.person_id === "number") activityPayload.person_id = toolArgs.person_id;
          if (typeof toolArgs.company_id === "number") activityPayload.company_id = toolArgs.company_id;

          createdFollowup = (await axiosInstance.post("/activities", activityPayload, { headers: requestHeaders })).data;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  call: createdCall,
                  note: createdNote,
                  followup: createdFollowup,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "complete_activity_with_notes": {
        if (typeof toolArgs.activity_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'activity_id' (number) é obrigatório.");
        }

        // 1) complete activity
        const completed = await axiosInstance.put(
          `/activities/${toolArgs.activity_id}`,
          { status: 2 },
          { headers: requestHeaders }
        );

        // 2) optional note
        let createdNote: any = null;
        if (typeof toolArgs.note_content === "string" && toolArgs.note_content.trim()) {
          // Try to resolve association
          let dealId: number | undefined = typeof toolArgs.deal_id === "number" ? toolArgs.deal_id : undefined;
          let personId: number | undefined = typeof toolArgs.person_id === "number" ? toolArgs.person_id : undefined;
          let companyId: number | undefined = typeof toolArgs.company_id === "number" ? toolArgs.company_id : undefined;

          if (!dealId && !personId && !companyId) {
            // fetch activity details to infer
            try {
              const act = await axiosInstance.get(`/activities/${toolArgs.activity_id}`, { headers: requestHeaders });
              const d = (act.data as any)?.data ?? act.data;
              if (typeof d?.deal_id === "number") dealId = d.deal_id;
              if (typeof d?.person_id === "number") personId = d.person_id;
              if (typeof d?.company_id === "number") companyId = d.company_id;
            } catch (_) {
              // ignore
            }
          }

          const notePayload: any = { content: toolArgs.note_content.trim() };
          if (dealId) notePayload.deal_id = dealId;
          else if (personId) notePayload.person_id = personId;
          else if (companyId) notePayload.company_id = companyId;

          if (notePayload.deal_id || notePayload.person_id || notePayload.company_id) {
            createdNote = (await axiosInstance.post("/notes", notePayload, { headers: requestHeaders })).data;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  activity: completed.data,
                  note: createdNote,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "revops_intake": {
        // Deal obrigatório
        if (typeof toolArgs.title !== "string" || !toolArgs.title.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "'title' (string) é obrigatório.");
        }
        if (typeof toolArgs.pipeline_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "'pipeline_id' (number) é obrigatório.");
        }
        if (typeof toolArgs.stage_id !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "'stage_id' (number) é obrigatório.");
        }

        const maxPages = typeof toolArgs.max_pages === "number" ? toolArgs.max_pages : 5;
        const show = typeof toolArgs.show === "number" ? toolArgs.show : 200;

        // Resolve routing key
        const routingKey =
          (typeof toolArgs.routing_key === "string" && toolArgs.routing_key.trim())
            ? toolArgs.routing_key.trim()
            : (
                (typeof toolArgs.person_email === "string" && toolArgs.person_email.trim())
                  ? toolArgs.person_email.trim()
                  : (
                      (typeof toolArgs.person_phone === "string" && toolArgs.person_phone.trim())
                        ? toolArgs.person_phone.trim()
                        : (
                            (typeof toolArgs.company_domain === "string" && toolArgs.company_domain.trim())
                              ? toolArgs.company_domain.trim()
                              : (
                                  (typeof toolArgs.company_name === "string" && toolArgs.company_name.trim())
                                    ? toolArgs.company_name.trim()
                                    : toolArgs.title.trim()
                                )
                          )
                    )
              );

        const candidates = Array.isArray(toolArgs.candidates_owner_ids)
          ? (toolArgs.candidates_owner_ids as any[]).filter((x) => typeof x === "number")
          : [];

        const autoOwner = candidates.length > 0 ? candidates[stableHash(routingKey) % candidates.length] : undefined;

        // Resolve owners (sem defaults de pipeline/stage; apenas escolhe owner quando possível)
        const dealOwnerId = typeof toolArgs.deal_owner_id === "number" ? toolArgs.deal_owner_id : autoOwner;
        const personOwnerId = typeof toolArgs.person_owner_id === "number" ? toolArgs.person_owner_id : autoOwner;
        const companyOwnerId = typeof toolArgs.company_owner_id === "number" ? toolArgs.company_owner_id : autoOwner;

        // 1) Company (upsert)
        let companyId: number | undefined = typeof toolArgs.company_id === "number" ? toolArgs.company_id : undefined;
        let companyResult: any = null;

        const companyName = typeof toolArgs.company_name === "string" ? toolArgs.company_name.trim() : "";
        const companyDomain = typeof toolArgs.company_domain === "string" ? toolArgs.company_domain : undefined;

        if (!companyId && (companyName || companyDomain)) {
          const companies = await listAllPages<any>({
            endpoint: "/companies",
            params: {},
            headers: requestHeaders,
            maxPages,
            show,
          });

          const foundCompany = companies.find((c) => findCompanyMatch(c, companyDomain, companyName));
          if (foundCompany && typeof foundCompany?.id === "number") {
            companyId = foundCompany.id;
            companyResult = { action: "matched", company: foundCompany };
          } else {
            if (!companyName) {
              throw new McpError(ErrorCode.InvalidParams, "Empresa não encontrada. Para criar, informe 'company_name'.");
            }
            if (typeof companyOwnerId !== "number") {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Empresa não encontrada. Para criar, informe 'company_owner_id' OU 'candidates_owner_ids' para roteamento."
              );
            }

            const payload: any = { name: companyName, owner_id: companyOwnerId };
            if (typeof toolArgs.company_email === "string" && toolArgs.company_email.trim()) payload.email = toolArgs.company_email;
            if (typeof toolArgs.company_phone === "string" && toolArgs.company_phone.trim()) payload.phone = toolArgs.company_phone;
            if (companyDomain) payload.website = companyDomain;

            const createdCompany = await axiosInstance.post("/companies", payload, { headers: requestHeaders });
            const createdCompanyId = (createdCompany.data as any)?.data?.id ?? (createdCompany.data as any)?.id;
            if (typeof createdCompanyId === "number") companyId = createdCompanyId;
            companyResult = { action: "created", company: createdCompany.data };
          }
        }

        // 2) Person (upsert)
        let personId: number | undefined = typeof toolArgs.person_id === "number" ? toolArgs.person_id : undefined;
        let personResult: any = null;

        const personName = typeof toolArgs.person_name === "string" ? toolArgs.person_name.trim() : "";
        const personEmail = typeof toolArgs.person_email === "string" ? toolArgs.person_email : undefined;
        const personPhone = typeof toolArgs.person_phone === "string" ? toolArgs.person_phone : undefined;

        if (!personId && (personName || personEmail || personPhone)) {
          const persons = await listAllPages<any>({
            endpoint: "/persons",
            params: {},
            headers: requestHeaders,
            maxPages,
            show,
          });

          const foundPerson = persons.find((p) => findPersonMatch(p, personEmail, personPhone));
          if (foundPerson && typeof foundPerson?.id === "number") {
            personId = foundPerson.id;
            personResult = { action: "matched", person: foundPerson };
          } else {
            if (!personName) {
              throw new McpError(ErrorCode.InvalidParams, "Pessoa não encontrada. Para criar, informe 'person_name'.");
            }
            if (typeof personOwnerId !== "number") {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Pessoa não encontrada. Para criar, informe 'person_owner_id' OU 'candidates_owner_ids' para roteamento."
              );
            }

            const payload: any = { name: personName, owner_id: personOwnerId };
            if (personEmail) payload.email = personEmail;
            if (personPhone) payload.phone = personPhone;
            if (companyId) payload.company_id = companyId;

            const createdPerson = await axiosInstance.post("/persons", payload, { headers: requestHeaders });
            const createdPersonId = (createdPerson.data as any)?.data?.id ?? (createdPerson.data as any)?.id;
            if (typeof createdPersonId === "number") personId = createdPersonId;
            personResult = { action: "created", person: createdPerson.data };
          }
        }

        // 3) Create deal
        const dealPayload: any = {
          title: toolArgs.title.trim(),
          pipeline_id: toolArgs.pipeline_id,
          stage_id: toolArgs.stage_id,
        };
        if (typeof toolArgs.value === "number") dealPayload.value = toolArgs.value;
        if (typeof dealOwnerId === "number") dealPayload.owner_id = dealOwnerId;
        if (personId) dealPayload.person_id = personId;
        if (companyId) dealPayload.company_id = companyId;

        const createdDeal = await axiosInstance.post("/deals", dealPayload, { headers: requestHeaders });
        const dealId = (createdDeal.data as any)?.data?.id ?? (createdDeal.data as any)?.id;

        // 4) Optional create call (if call_body provided)
        let createdCall: any = null;
        if (toolArgs.call_body && typeof toolArgs.call_body === "object") {
          createdCall = (await axiosInstance.post("/calls", toolArgs.call_body, { headers: requestHeaders })).data;
        }

        // 5) Note (scraping + call outcome)
        let createdNote: any = null;
        const noteParts: string[] = [];
        if (typeof toolArgs.note_content === "string" && toolArgs.note_content.trim()) noteParts.push(toolArgs.note_content.trim());
        if (typeof toolArgs.call_outcome === "string" && toolArgs.call_outcome.trim()) noteParts.push(`Outcome: ${toolArgs.call_outcome.trim()}`);

        const finalNote = noteParts.join("\n\n");
        if (finalNote && typeof dealId === "number") {
          createdNote = (await axiosInstance.post(
            "/notes",
            { content: finalNote, deal_id: dealId },
            { headers: requestHeaders }
          )).data;
        }

        // 6) Meeting (optional)
        let createdMeeting: any = null;
        if (toolArgs.meeting && typeof toolArgs.meeting === "object") {
          const m = toolArgs.meeting as any;
          const payload: any = {
            title: String(m.title || "Reunião").trim(),
            deal_id: dealId,
            activity_type_id: typeof m.activity_type_id === "number" ? m.activity_type_id : ACTIVITY_TYPE_MEETING_ID_DEFAULT,
            status: typeof m.status === "number" ? m.status : 0,
          };
          if (typeof m.owner_id === "number") payload.owner_id = m.owner_id;
          else if (typeof dealOwnerId === "number") payload.owner_id = dealOwnerId;
          if (typeof m.start_at === "string" && m.start_at.trim()) payload.start_at = formatDateToYmd(m.start_at);
          if (typeof m.end_at === "string" && m.end_at.trim()) payload.end_at = formatDateToYmd(m.end_at);
          if (typeof m.description === "string") payload.description = m.description;

          createdMeeting = (await axiosInstance.post("/activities", payload, { headers: requestHeaders })).data;
        }

        // 7) Follow-up (optional)
        let createdFollowup: any = null;
        if (toolArgs.followup && typeof toolArgs.followup === "object") {
          const f = toolArgs.followup as any;
          const payload: any = {
            title: String(f.title || "Follow-up").trim(),
            deal_id: dealId,
            activity_type_id: typeof f.activity_type_id === "number" ? f.activity_type_id : ACTIVITY_TYPE_CALL_ID_DEFAULT,
            status: typeof f.status === "number" ? f.status : 0,
          };
          if (typeof f.owner_id === "number") payload.owner_id = f.owner_id;
          else if (typeof dealOwnerId === "number") payload.owner_id = dealOwnerId;
          if (typeof f.start_at === "string" && f.start_at.trim()) payload.start_at = formatDateToYmd(f.start_at);
          if (typeof f.end_at === "string" && f.end_at.trim()) payload.end_at = formatDateToYmd(f.end_at);
          if (typeof f.description === "string") payload.description = f.description;

          createdFollowup = (await axiosInstance.post("/activities", payload, { headers: requestHeaders })).data;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  routing_key: routingKey,
                  auto_owner_id: autoOwner,
                  resolved_owners: {
                    deal_owner_id: dealOwnerId,
                    person_owner_id: personOwnerId,
                    company_owner_id: companyOwnerId,
                  },
                  company: companyResult,
                  person: personResult,
                  deal: createdDeal.data,
                  deal_id: dealId,
                  note: createdNote,
                  call: createdCall,
                  meeting: createdMeeting,
                  followup: createdFollowup,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Ferramenta desconhecida: ${name}`
        );
    }
  } catch (error) {
    const toolName = name || request?.params?.name || "desconhecida";
    console.error(`Erro ao executar a ferramenta ${toolName}:`, error);

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;
      const message = `Erro na API PipeRun (${status}): ${
        (data ? JSON.stringify(data) : "") || axiosError.message
      }`;

      let errorCode = ErrorCode.InternalError;
      if (status === 401 || status === 403) errorCode = ErrorCode.InvalidRequest;
      else if (status === 400 || status === 422) errorCode = ErrorCode.InvalidParams;
      else if (status === 404) errorCode = ErrorCode.InvalidRequest;

      throw new McpError(errorCode, message);
    }

    if (error instanceof McpError) {
      throw error;
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Erro interno do servidor: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// 6. Tratamento de erros do servidor MCP e encerramento gracioso
server.onerror = (error: unknown) => {
  console.error("[MCP Server Error]", error);
};

process.on("SIGINT", async () => {
  console.error("Recebido SIGINT. Encerrando servidor MCP...");
  await server.close();
  process.exit(0);
});

// 7. Função principal para iniciar o servidor
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Servidor MCP PipeRun rodando via stdio...");
}

main().catch((error) => {
  console.error("Erro fatal no servidor MCP:", error);
  process.exit(1);
});