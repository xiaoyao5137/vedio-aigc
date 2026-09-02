export type AppPage = 'workflow' | 'characters' | 'models'
export type WorkflowView = 'list' | 'edit' | 'run'
export type RunnerTab = 'execute' | 'history'

export type AppViewState = {
  page: AppPage
  workflowView: WorkflowView
  activeWorkflowId: string
  runnerTab: RunnerTab
}

export const APP_VIEW_STATE_STORAGE_KEY = 'vedio-aigc:app-view-state:v1'

const pages = new Set<AppPage>(['workflow', 'characters', 'models'])
const workflowViews = new Set<WorkflowView>(['list', 'edit', 'run'])
const runnerTabs = new Set<RunnerTab>(['execute', 'history'])

export function parseAppViewState(value: string | null): Partial<AppViewState> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      ...(pages.has(parsed.page as AppPage) ? { page: parsed.page as AppPage } : {}),
      ...(workflowViews.has(parsed.workflowView as WorkflowView) ? { workflowView: parsed.workflowView as WorkflowView } : {}),
      ...(typeof parsed.activeWorkflowId === 'string' ? { activeWorkflowId: parsed.activeWorkflowId } : {}),
      ...(runnerTabs.has(parsed.runnerTab as RunnerTab) ? { runnerTab: parsed.runnerTab as RunnerTab } : {}),
    }
  } catch {
    return {}
  }
}

export function loadAppViewState(storage?: Pick<Storage, 'getItem'>): Partial<AppViewState> {
  if (!storage) return {}
  return parseAppViewState(storage.getItem(APP_VIEW_STATE_STORAGE_KEY))
}

export function saveAppViewState(storage: Pick<Storage, 'setItem'>, state: AppViewState) {
  storage.setItem(APP_VIEW_STATE_STORAGE_KEY, JSON.stringify(state))
}
