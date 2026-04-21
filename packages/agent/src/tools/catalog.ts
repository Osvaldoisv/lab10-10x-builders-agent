import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description:
      "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "high",
    requires_integration: "github",
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
    description:
      "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
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
    description:
      "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "high",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: {
          type: "boolean",
          description: "Whether the repository is private",
        },
      },
      required: ["name"],
    },
  },
  {
    id: "google_calendar_get_events",
    name: "google_calendar_get_events",
    description:
      "Lista los próximos eventos del calendario de Google del usuario.",
    risk: "low",
    requires_integration: "google_calendar",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Ejecuta un comando de shell en el servidor. Requiere confirmación.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Identificador lógico del terminal (para correlación y logs)",
        },
        prompt: {
          type: "string",
          description: "Comando a ejecutar con bash -lc",
        },
      },
      required: ["prompt"],
    },
  },
  {
    id: "google_calendar_confirm_attendance",
    name: "google_calendar_confirm_attendance",
    description:
      "Confirma la asistencia del usuario a un evento del calendario de Google. Requiere confirmación.",
    risk: "medium",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "ID del evento de Google Calendar",
        },
      },
      required: ["event_id"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
