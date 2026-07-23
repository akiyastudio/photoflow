param(
    [string]$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\.."))
)

$ErrorActionPreference = "Stop"

function Download-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [string]$Destination,
        [Parameter(Mandatory = $true)]
        [long]$MinimumBytes
    )

    if ((Test-Path -LiteralPath $Destination) -and
        ((Get-Item -LiteralPath $Destination).Length -ge $MinimumBytes)) {
        Write-Host "Using existing file: $Destination"
        return
    }

    $Parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    $Partial = "$Destination.partial"
    if (Test-Path -LiteralPath $Partial) {
        Remove-Item -LiteralPath $Partial -Force
    }

    & curl.exe --location --fail --retry 3 --retry-delay 2 --output $Partial $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed with exit code $LASTEXITCODE`: $Url"
    }
    if ((Get-Item -LiteralPath $Partial).Length -lt $MinimumBytes) {
        throw "Downloaded file is unexpectedly small: $Partial"
    }
    Move-Item -LiteralPath $Partial -Destination $Destination -Force
}

$ModelRoot = Join-Path $WorkspaceRoot ".model-lab\models\plan1"

$Models = @(
    [ordered]@{
        name = "yunet-face-detection-2023mar"
        file = "yunet\face_detection_yunet_2023mar.onnx"
        url = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
        minimum_bytes = 100000
        source = "OpenCV Zoo"
        purpose = "face anchor detection"
    },
    [ordered]@{
        name = "rtmpose-m-halpe26-256x192"
        file = "rtmpose\rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605.zip"
        url = "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605.zip"
        minimum_bytes = 10000000
        source = "OpenMMLab MMPose"
        purpose = "26-keypoint body completeness verification"
    },
    [ordered]@{
        name = "rtmdet-ins-m-coco"
        file = "rtmdet-ins\rtmdet-ins_m_8xb32-300e_coco_20221123_001039-6eba602e.pth"
        url = "https://download.openmmlab.com/mmdetection/v3.0/rtmdet/rtmdet-ins_m_8xb32-300e_coco/rtmdet-ins_m_8xb32-300e_coco_20221123_001039-6eba602e.pth"
        minimum_bytes = 50000000
        source = "OpenMMLab MMDetection"
        purpose = "person boxes and initial visible-person masks; export pending"
    },
    [ordered]@{
        name = "rtmdet-ins-m-config"
        file = "rtmdet-ins\rtmdet-ins_m_8xb32-300e_coco.py"
        url = "https://raw.githubusercontent.com/open-mmlab/mmdetection/v3.3.0/configs/rtmdet/rtmdet-ins_m_8xb32-300e_coco.py"
        minimum_bytes = 100
        source = "OpenMMLab MMDetection v3.3.0"
        purpose = "reproducible RTMDet-Ins-m export configuration"
    }
)

foreach ($Model in $Models) {
    $Destination = Join-Path $ModelRoot $Model.file
    Download-Checked -Url $Model.url -Destination $Destination -MinimumBytes $Model.minimum_bytes
    $File = Get-Item -LiteralPath $Destination
    $Model.bytes = $File.Length
    $Model.sha256 = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
}

$PoseName = "rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605"
$PoseArchive = Join-Path $ModelRoot "rtmpose\$PoseName.zip"
$PoseOnnx = Join-Path $ModelRoot "rtmpose\$PoseName.onnx"
if (-not (Test-Path -LiteralPath $PoseOnnx)) {
    $ExtractRoot = Join-Path $WorkspaceRoot ".model-lab\cache\rtmpose-m-halpe26"
    New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null
    Expand-Archive -LiteralPath $PoseArchive -DestinationPath $ExtractRoot -Force
    $ExtractedOnnx = Get-ChildItem -LiteralPath $ExtractRoot -Recurse -Filter "end2end.onnx" |
        Select-Object -First 1
    if ($null -eq $ExtractedOnnx) {
        throw "The RTMPose archive did not contain end2end.onnx"
    }
    Copy-Item -LiteralPath $ExtractedOnnx.FullName -Destination $PoseOnnx
}

$PoseRecord = $Models | Where-Object { $_.name -eq "rtmpose-m-halpe26-256x192" }
$PoseRecord.extracted_file = "rtmpose\$PoseName.onnx"
$PoseRecord.extracted_bytes = (Get-Item -LiteralPath $PoseOnnx).Length
$PoseRecord.extracted_sha256 = (Get-FileHash -LiteralPath $PoseOnnx -Algorithm SHA256).Hash.ToLowerInvariant()

$ManifestPath = Join-Path $ModelRoot "manifest.json"
$Manifest = [ordered]@{
    generated_at_utc = [DateTime]::UtcNow.ToString("o")
    models = $Models
}
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
Write-Host "Model manifest: $ManifestPath"
