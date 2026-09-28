export function assertModelProviderAllowed(model: { provider: string; settings?: Record<string, string> }) {
  let hostname = ''
  try { hostname = new URL(model.settings?.endpoint ?? '').hostname.toLowerCase() } catch { /* Missing endpoints are validated by adapters. */ }
  if (model.provider.toLowerCase() === 'ofox' || /(^|\.)ofox\.(ai|com)$/.test(hostname)) {
    throw new Error('MODEL_PROVIDER_DISABLED: 用户已禁用 Ofox，所有模型能力均禁止通过 Ofox 调用。请配置用户指定的服务。')
  }
}
