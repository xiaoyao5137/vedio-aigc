export function assetDownloadUrl(url: string, filename: string) {
  return /^https?:\/\//i.test(url)
    ? `/api/media-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`
    : url
}
