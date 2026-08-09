param(
  [string]$Port = '9335',
  [string]$Output = 'C:\dev\app1\docs-publish\captures\current.png',
  [string]$Expression = ''
)

$ErrorActionPreference = 'Stop'
$page = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" | Where-Object { $_.type -eq 'page' -and $_.url -like 'http://localhost:5173*' } | Select-Object -First 1
if (-not $page) { throw '未找到照片流开发版页面' }

$socket = [System.Net.WebSockets.ClientWebSocket]::new()
$socket.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
$script:messageId = 0

function Invoke-Cdp([string]$Method, [hashtable]$Params = @{}) {
  $script:messageId += 1
  $id = $script:messageId
  $json = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  while ($true) {
    $stream = [IO.MemoryStream]::new()
    do {
      $buffer = New-Object byte[] 65536
      $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($result.Count) { $stream.Write($buffer, 0, $result.Count) }
    } while (-not $result.EndOfMessage)
    $response = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
    if ($response.id -eq $id) { return $response }
  }
}

Invoke-Cdp 'Page.enable' | Out-Null
Invoke-Cdp 'Runtime.enable' | Out-Null
if ($Expression) {
  $expressionResponse = Invoke-Cdp 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
  if ($null -ne $expressionResponse.result.result.value) { $expressionResponse.result.result.value }
  Start-Sleep -Milliseconds 700
}
$textResponse = Invoke-Cdp 'Runtime.evaluate' @{ expression = 'document.body.innerText'; returnByValue = $true }
$textResponse.result.result.value
$shot = Invoke-Cdp 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true }
[IO.File]::WriteAllBytes($Output, [Convert]::FromBase64String($shot.result.data))
$socket.Abort()
$socket.Dispose()
