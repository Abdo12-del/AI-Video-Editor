import type { AppSettings, ChatResponse, ProjectData } from '../shared/types'
import type { ProgressReporter } from './mediaEngine'
import type { GeminiFunctionDeclaration, GeminiSchema } from './geminiProvider'

export interface AgentToolContext {
  project: ProjectData
  settings: AppSettings
  jobId: string
  report: ProgressReporter
}

export interface AgentToolResult {
  project: ProjectData
  result: unknown
  proposal?: ChatResponse['proposal']
}

export interface AgentToolDefinition extends GeminiFunctionDeclaration {
  mutatesProject: boolean
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> | AgentToolResult
}

const registry = new Map<string, AgentToolDefinition>()

function isValidSchema(value: GeminiSchema): boolean {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string')
}

export function registerAgentTool(definition: AgentToolDefinition): () => void {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(definition.name)) throw new Error(`Invalid agent tool name: ${definition.name}`)
  if (!definition.description.trim() || !isValidSchema(definition.parameters)) throw new Error(`Invalid schema for agent tool: ${definition.name}`)
  if (registry.has(definition.name)) throw new Error(`Agent tool is already registered: ${definition.name}`)
  registry.set(definition.name, definition)
  return () => registry.delete(definition.name)
}

export function getAgentToolDefinitions(): AgentToolDefinition[] {
  return [...registry.values()]
}

export function getGeminiToolDeclarations(): GeminiFunctionDeclaration[] {
  return getAgentToolDefinitions().map(({ name, description, parameters }) => ({ name, description, parameters }))
}

export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  context: AgentToolContext
): Promise<AgentToolResult> {
  const definition = registry.get(name)
  if (!definition) return { project: context.project, result: { ok: false, error: 'This tool is not available in the current application version.' } }
  return definition.execute(args, context)
}
