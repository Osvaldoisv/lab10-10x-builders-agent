export type Channel = "web" | "telegram";

export type ToolRisk = "low" | "medium" | "high";

export interface Profile {
  id: string;
  name: string;
  timezone: string;
  language: string;
  agent_name: string;
  agent_system_prompt: string;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserIntegration {
  id: string;
  user_id: string;
  provider: string;
  scopes: string[];
  status: "active" | "revoked" | "expired";
  created_at: string;
}

export interface UserToolSetting {
  id: string;
  user_id: string;
  tool_id: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  user_id: string;
  channel: Channel;
  status: "active" | "closed";
  budget_tokens_used: number;
  budget_tokens_limit: number;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  structured_payload?: Record<string, unknown>;
  created_at: string;
}

export interface ToolCall {
  id: string;
  session_id: string;
  tool_name: string;
  arguments_json: Record<string, unknown>;
  result_json?: Record<string, unknown>;
  status: "pending_confirmation" | "approved" | "rejected" | "executed" | "failed";
  requires_confirmation: boolean;
  created_at: string;
  finished_at?: string;
}

export interface TelegramAccount {
  id: string;
  user_id: string;
  telegram_user_id: number;
  chat_id: number;
  linked_at: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  requires_integration?: string;
  parameters_schema: Record<string, unknown>;
  displayName?: string;
  displayDescription?: string;
}

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    displayName: "Preferencias del usuario",
    displayDescription: "Consulta tu configuración y preferencias.",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    displayName: "Listar herramientas",
    displayDescription: "Muestra qué herramientas tienes habilitadas.",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    displayName: "GitHub: listar repos",
    displayDescription: "Lista tus repositorios de GitHub.",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    displayName: "GitHub: listar issues",
    displayDescription: "Lista issues de un repositorio.",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    displayName: "GitHub: crear issue",
    displayDescription: "Crea un issue nuevo (requiere confirmación).",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "high",
    requires_integration: "github",
    displayName: "GitHub: crear repositorio",
    displayDescription: "Crea un repositorio nuevo (requiere confirmación).",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
  },
  {
    id: "google_calendar_get_events",
    name: "google_calendar_get_events",
    description: "Lists the user's upcoming Google Calendar events.",
    risk: "low",
    requires_integration: "google_calendar",
    displayName: "Google Calendar: ver eventos",
    displayDescription: "Lista tus próximos eventos del calendario.",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "google_calendar_confirm_attendance",
    name: "google_calendar_confirm_attendance",
    description: "Confirms the user's attendance to a Google Calendar event. Requires confirmation.",
    risk: "medium",
    requires_integration: "google_calendar",
    displayName: "Google Calendar: confirmar asistencia",
    displayDescription: "Confirma tu asistencia a un evento (requiere confirmación).",
    parameters_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "ID del evento de Google Calendar" },
      },
      required: ["event_id"],
    },
  },
  {
    id: "bash",
    name: "bash",
    description: "Executes a shell command on the server. Requires confirmation.",
    risk: "high",
    displayName: "Bash: ejecutar comandos",
    displayDescription: "Ejecuta comandos de shell en el servidor (requiere confirmación). Solo para entornos self-hosted con BASH_TOOL_ENABLED=true.",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: { type: "string", description: "Identificador lógico del terminal" },
        prompt: { type: "string", description: "Comando a ejecutar con bash -lc" },
      },
      required: ["prompt"],
    },
  },
  {
    id: "read_file",
    name: "read_file",
    description:
      "Reads an existing text file under the configured workspace root. Use this when you need to inspect source code, config, logs, or any UTF-8 text without changing it. Do not use this to create or modify files; use write_file or edit_file instead.\nParameters: path is relative to the workspace root (no ..). Optional offset is the 1-based start line number. Optional limit is the maximum number of lines to return starting at offset.\nSuccessful output: { ok: true, tool: 'read_file', path, content, startLine, endLine, totalLines }.\nFailure output: { ok: false, tool: 'read_file', path, error: { code, message } }.",
    risk: "low",
    displayName: "Leer archivo",
    displayDescription: "Lee un archivo de texto existente dentro del workspace (opcionalmente por rango de líneas). Requiere FILE_TOOLS_ROOT configurado.",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa al workspace root (sin ..)" },
        offset: { type: "number", description: "Línea inicial 1-based (opcional)" },
        limit: { type: "number", description: "Número máximo de líneas a retornar (opcional)" },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a new file with the given UTF-8 content. Use this only when the file must not exist yet. If the file already exists, this tool fails—use edit_file instead.\nParameters: path relative to the workspace root; content is the full file body.\nSuccessful output: { ok: true, tool: 'write_file', path, bytesWritten }.\nFailure output: { ok: false, tool: 'write_file', path, error: { code, message } }.\nHuman approval: This tool mutates disk and runs only after user confirmation.",
    risk: "high",
    displayName: "Crear archivo",
    displayDescription: "Crea un archivo nuevo con contenido completo (requiere confirmación). Falla si el archivo ya existe.",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa al workspace root (sin ..)" },
        content: { type: "string", description: "Contenido completo del archivo a crear" },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Edits an existing UTF-8 text file by replacing exactly one occurrence of old_string with new_string. Do not use this to create a new file. old_string must match uniquely.\nParameters: path relative to the workspace root; old_string and new_string are literal substrings (not regex).\nSuccessful output: { ok: true, tool: 'edit_file', path, replacements: 1 }.\nFailure output: { ok: false, tool: 'edit_file', path, error: { code, message } }.\nHuman approval: This tool mutates disk and runs only after user confirmation.",
    risk: "high",
    displayName: "Editar archivo",
    displayDescription: "Reemplaza una única aparición de un fragmento en un archivo existente (requiere confirmación).",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa al workspace root (sin ..)" },
        old_string: { type: "string", description: "Fragmento literal exacto a reemplazar" },
        new_string: { type: "string", description: "Texto de reemplazo" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
];

export interface ConfirmationRequired {
  pending_confirmation: true;
  tool_call_id: string;
  action: string;
  params: Record<string, unknown>;
  description: string;
}
