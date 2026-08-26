#Requires -Version 5.1
<#
LarkSnap 一键安装（Windows）

远程一键装（不用先 clone）：
  irm https://raw.githubusercontent.com/AmbroseX/larksnap/main/install.ps1 | iex

要带参数时：
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/AmbroseX/larksnap/main/install.ps1))) -Yes

已经 clone 了仓库：
  .\install.ps1              装技能 + 检查依赖 + 把 daemon 装成登录自启的常驻任务
  .\install.ps1 -Link        技能改成软链指向仓库（开发用，需开发者模式或管理员）
  .\install.ps1 -Update      只更新技能到最新版并重启 daemon（已经装过的用这个）
  .\install.ps1 -NoService   不注册常驻任务
  .\install.ps1 -Yes         不询问，一路同意
  .\install.ps1 -Uninstall   停任务、删任务与已安装的技能目录
#>
[CmdletBinding()]
param(
  [switch]$Update,
  [switch]$Link,
  [switch]$NoService,
  [switch]$Yes,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Get-EnvOr($name, $fallback) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($v)) { return $fallback }
  return $v
}

$RepoSlug   = Get-EnvOr 'LARKSNAP_REPO' 'AmbroseX/larksnap'
$RepoBranch = Get-EnvOr 'LARKSNAP_BRANCH' 'main'
# Chrome 应用商店页：装完直接把这一页打开，省得用户自己去搜
$StoreUrl   = Get-EnvOr 'LARKSNAP_STORE_URL' 'https://chromewebstore.google.com/detail/gepndmikbdjpdedkfiejchmhmhegjeal'
$SkillName  = 'larksnap-fetch'
$SkillsDir  = Get-EnvOr 'LARKSNAP_SKILLS_DIR' (Join-Path $HOME '.claude\skills')
$SkillDst   = Join-Path $SkillsDir $SkillName
$DaemonRel  = 'scripts\bridge\daemon.mjs'
$Port       = Get-EnvOr 'LARKSNAP_PORT' '19925'
$HomeDir    = Join-Path $HOME '.larksnap'
$LogPath    = Join-Path $HomeDir 'daemon.log'
$PidPath    = Join-Path $HomeDir 'daemon.pid'
$VbsPath    = Join-Path $HomeDir 'start-daemon.vbs'
$TaskName   = 'LarkSnapDaemon'

if ($env:LARKSNAP_YES -eq '1') { $Yes = $true }

function Info($msg) { Write-Host "[安装] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[注意] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[失败] $msg" -ForegroundColor Red; throw '安装中止' }

# 非交互（比如放进无人值守脚本）时问不到人，一律走默认
function Ask($msg) {
  if ($Yes) { return $true }
  if (-not [Environment]::UserInteractive) { return $false }
  $reply = Read-Host "$msg [y/N]"
  return ($reply -match '^[Yy]$')
}

# 用默认浏览器打开一个地址。打不开就算了，地址本来就已经打印在屏幕上。
# 设环境变量 LARKSNAP_NO_OPEN=1 可以彻底关掉。
function Open-Url($url) {
  if ($env:LARKSNAP_NO_OPEN -eq '1') { return $false }
  try { Start-Process $url | Out-Null; return $true } catch { return $false }
}

# 技能版本号就看 protocol.mjs 里的 DAEMON_VERSION，没有额外的版本文件
function Get-SkillVersion($dir) {
  $f = Join-Path $dir 'scripts\bridge\protocol.mjs'
  if (-not (Test-Path $f)) { return $null }
  $m = Select-String -Path $f -Pattern "DAEMON_VERSION\s*=\s*'([^']+)'" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return $null
}

# ---------- 源码位置：本地仓库直接用，管道执行就去 GitHub 拉一份 ----------

function Get-SelfDir {
  if ($PSScriptRoot) { return $PSScriptRoot }
  if ($MyInvocation.MyCommand.Path) { return (Split-Path -Parent $MyInvocation.MyCommand.Path) }
  return $null
}

# 从 GitHub 取技能：下到临时目录，装完就删，本机不留源码副本
$script:TmpDir = $null

function Get-SkillSrc {
  $url = "https://codeload.github.com/$RepoSlug/zip/refs/heads/$RepoBranch"
  Info "从 GitHub 取技能（$RepoSlug@$RepoBranch）…"
  $script:TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("larksnap-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:TmpDir -Force | Out-Null
  $zip = Join-Path $script:TmpDir 'src.zip'
  try {
    # 老版 PowerShell 默认走 TLS1.0，GitHub 早就不认了
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  } catch {
    Fail "下载失败：$url（$($_.Exception.Message)）"
  }
  Expand-Archive -Path $zip -DestinationPath $script:TmpDir -Force
  $dir = Get-ChildItem -Path $script:TmpDir -Directory -Recurse -Depth 2 |
    Where-Object { $_.Name -eq $SkillName -and $_.Parent.Name -eq 'skills' } |
    Select-Object -First 1
  if (-not $dir) { Fail "包里没找到技能目录 skills\$SkillName" }
  return $dir.FullName
}

$selfDir = Get-SelfDir
$Remote = $true
$RepoDir = $null
if ($selfDir -and (Test-Path (Join-Path $selfDir "skills\$SkillName"))) {
  $Remote = $false
  $RepoDir = $selfDir
}

# ---------- 停 daemon：只认 PID 文件 ----------
function Stop-Daemon {
  if (-not (Test-Path $PidPath)) { return }
  $raw = (Get-Content $PidPath -Raw).Trim()
  if ($raw -match '^\d+$') {
    $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    if ($p) { Stop-Process -Id ([int]$raw) -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

function Test-Ping {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/ping" -UseBasicParsing -TimeoutSec 2
    return $r.Content
  } catch { return $null }
}

# ---------- 常驻任务：VBS 静默拉起 + 计划任务（登录自启 + 每 5 分钟兜底） ----------

# daemon 要调用 yt-dlp / ffmpeg，计划任务拿到的 PATH 未必包含它们的目录，
# 这里把探到的真实目录补进去；顺便隐藏控制台窗口（Run 的第二个参数 0）
function Write-Vbs($nodeBin, $daemonPath) {
  $extra = @()
  foreach ($bin in @('yt-dlp', 'ffmpeg', 'node')) {
    $cmd = Get-Command $bin -ErrorAction SilentlyContinue
    if ($cmd) { $extra += (Split-Path -Parent $cmd.Source) }
  }
  $extraPath = ($extra | Select-Object -Unique) -join ';'
  $vbs = @"
' LarkSnap daemon 静默启动器（由 install.ps1 生成，别手改）
Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("PROCESS")
env("PATH") = env("PATH") & ";$extraPath"
env("LARKSNAP_PORT") = "$Port"
sh.Run """$nodeBin"" ""$daemonPath""", 0, False
"@
  Set-Content -Path $VbsPath -Value $vbs -Encoding ASCII
}

function Register-DaemonTask {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$VbsPath`""
  $atLogon = New-ScheduledTaskTrigger -AtLogOn
  # daemon 空闲 30 分钟会自退，靠这条每 5 分钟的重复触发把它再拉起来
  # （已经在跑的实例抢不到端口会自己退出，重复拉起是安全的）
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $trigger = @($atLogon, $repeat)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'LarkSnap 桥接 daemon（浏览器扩展 <-> 本地 CLI）' | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

function Unregister-DaemonTask {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# ---------- 卸载 ----------
if ($Uninstall) {
  Info '停掉常驻任务…'
  Unregister-DaemonTask
  Stop-Daemon
  Remove-Item $VbsPath -Force -ErrorAction SilentlyContinue
  if (Test-Path $SkillDst) {
    # 软链要单独删，不然会把仓库里的原文件一起删了
    $item = Get-Item $SkillDst -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $SkillDst -Recurse -Force }
    Info "已删除技能目录：$SkillDst"
  }
  Info "卸载完成（$HomeDir 下的日志和密钥保留，不需要就自己删）"
  return
}

# ---------- 0. -Update 只对装过的机器有意义 ----------
if ($Update -and -not (Test-Path $SkillDst)) {
  Fail "还没装过技能（$SkillDst 不存在），去掉 -Update 跑一次完整安装"
}

# ---------- 1. 检查 Node ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail '没找到 node。先装 Node.js 18+：winget install OpenJS.NodeJS.LTS（装完新开一个终端再跑本脚本）'
}
$NodeBin = $nodeCmd.Source
$NodeVer = (& node -p 'process.versions.node').Trim()
if ([int]($NodeVer.Split('.')[0]) -lt 18) { Fail "Node 版本太低（当前 v$NodeVer），需要 18 以上" }
Info "Node 就绪：$NodeBin (v$NodeVer)"

# ---------- 2. 找到技能来源 ----------
if ($Remote) {
  $SkillSrc = Get-SkillSrc
  if ($Link) { Warn '-Link 只在本地仓库里有意义，这次改成复制安装'; $Link = $false }
} else {
  $SkillSrc = Join-Path $RepoDir "skills\$SkillName"
}
if (-not (Test-Path $SkillSrc)) { Fail "找不到技能目录：$SkillSrc" }

# ---------- 3. 装技能 ----------
$OldVer = Get-SkillVersion $SkillDst
# 旧 daemon 还占着旧代码，先让它退出；服务模式下后面会再拉起来
if ($OldVer) { Stop-Daemon }

New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null
New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
if (Test-Path $SkillDst) {
  $old = Get-Item $SkillDst -Force
  if ($old.LinkType) { $old.Delete() } else { Remove-Item $SkillDst -Recurse -Force }
}
if ($Link) {
  try {
    New-Item -ItemType SymbolicLink -Path $SkillDst -Target $SkillSrc | Out-Null
    Info "技能已软链：$SkillDst -> $SkillSrc（改仓库代码即时生效）"
  } catch {
    Warn '建软链失败（要开发者模式或管理员权限），改成复制安装'
    Copy-Item $SkillSrc $SkillDst -Recurse -Force
    Info "技能已安装：$SkillDst"
  }
} else {
  Copy-Item $SkillSrc $SkillDst -Recurse -Force
  $NewVer = Get-SkillVersion $SkillDst
  if (-not $OldVer) {
    Info "技能已安装：$SkillDst（v$NewVer）"
  } elseif ($OldVer -eq $NewVer) {
    Info "技能已是最新：$SkillDst（v$NewVer，没有变化）"
  } else {
    Info "技能已更新：v$OldVer → v$NewVer（$SkillDst）"
  }
}
if ($script:TmpDir -and (Test-Path $script:TmpDir)) {
  Remove-Item $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

# -Update 到此为止：不查依赖、不重装任务、不跳商店，只把 daemon 换成新代码
if ($Update) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskName $TaskName
    Info '常驻任务已重新拉起，跑的是新技能代码'
  } else {
    Info '没装常驻任务，daemon 下次用到时会自动拉起新版本'
  }
  return
}

# ---------- 4. 可选依赖：yt-dlp / ffmpeg（只有「下载视频」用得到） ----------
$missing = @()
foreach ($bin in @('yt-dlp', 'ffmpeg')) {
  if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) { $missing += $bin }
}
if ($missing.Count -eq 0) {
  Info '视频下载依赖齐全：yt-dlp、ffmpeg'
} else {
  Warn "缺少 $($missing -join '、')（只影响「下载视频」，抓取和编辑飞书文档不需要）"
  $pkgIds = @{ 'yt-dlp' = 'yt-dlp.yt-dlp'; 'ffmpeg' = 'Gyan.FFmpeg' }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $cmdText = 'winget install ' + (($missing | ForEach-Object { $pkgIds[$_] }) -join ' ')
    if (Ask "现在执行 ``$cmdText`` 装上吗？") {
      foreach ($m in $missing) {
        # 装失败不该中断整个安装：视频下载只是可选功能
        try { & winget install --id $pkgIds[$m] -e --accept-package-agreements --accept-source-agreements }
        catch { Warn "$m 安装没成功，之后可手动跑：winget install $($pkgIds[$m])" }
      }
      Warn '装完可能要新开一个终端，PATH 才会刷新'
    } else {
      Warn "跳过了，之后想装就跑：$cmdText"
    }
  } elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
    Warn "用 scoop 装：scoop install $($missing -join ' ')"
  } else {
    Warn "没有 winget / scoop，请自行安装：$($missing -join '、')"
  }
}

# ---------- 5. daemon 常驻任务 ----------
if ($NoService) {
  Info '按 -NoService 跳过常驻任务；daemon 会在第一次跑 fetch.mjs 时自动拉起'
} else {
  # 先把旧的都停掉：任务里的和之前自动拉起的，免得抢 $Port 端口
  Unregister-DaemonTask
  Stop-Daemon

  $daemonPath = Join-Path $SkillDst $DaemonRel
  Write-Vbs $NodeBin $daemonPath
  try {
    Register-DaemonTask
    Info "已注册登录自启（计划任务 $TaskName），每 5 分钟兜底检查一次"
  } catch {
    Warn "注册计划任务失败（$($_.Exception.Message)），改成后台直接启动（重启后要再跑一次本脚本）"
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden
  }

  # 等它真的在听端口，最多 5 秒
  $ready = $null
  for ($i = 0; $i -lt 25; $i++) {
    $ready = Test-Ping
    if ($ready) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($ready) {
    $ver = '?'
    if ($ready -match '"daemonVersion":"([^"]+)"') { $ver = $Matches[1] }
    Info "daemon 已在 127.0.0.1:$Port 运行（v$ver）"
  } else {
    Warn "daemon 5 秒内没应答 /ping，看日志：$LogPath"
  }
}

Write-Host ''
Info '装好了。还差最后一步——装浏览器扩展（登录态和导出引擎都在扩展里）：'
if ($Remote) {
  Write-Host "  1) 到 Chrome 应用商店装扩展（这一页等下会自动打开）："
  Write-Host "     $StoreUrl"
  Write-Host "     打不开就到 https://github.com/$RepoSlug/releases 下 zip 解压"
  Write-Host "     （下 zip 的话：chrome://extensions → 开「开发者模式」→「加载已解压的扩展程序」选解压出的目录）"
} elseif (Test-Path (Join-Path $RepoDir 'dist')) {
  Write-Host "  1) chrome://extensions → 开「开发者模式」→「加载已解压的扩展程序」，选：$(Join-Path $RepoDir 'dist')"
} else {
  Write-Host "  1) 先构建：cd $RepoDir; npm install; npm run build，再到 chrome://extensions 加载 dist 目录"
}
Write-Host "  2) 点一下扩展图标唤醒后台，它会自动连上本地 daemon"
Write-Host ''
Write-Host "  日志：$LogPath"
if ($Remote) {
  Write-Host "  更新技能：& ([scriptblock]::Create((irm https://raw.githubusercontent.com/$RepoSlug/$RepoBranch/install.ps1))) -Update"
  Write-Host "  卸载：& ([scriptblock]::Create((irm https://raw.githubusercontent.com/$RepoSlug/$RepoBranch/install.ps1))) -Uninstall"
} else {
  Write-Host "  更新技能：.\install.ps1 -Update"
  Write-Host "  卸载：.\install.ps1 -Uninstall"
}

# 远程装的人多半是直接照着提示走的，帮他把商店页点开
if ($Remote) {
  Write-Host ''
  if (Open-Url $StoreUrl) {
    Info '已经帮你打开商店页面了；没弹出来就手动开上面那个地址'
  } else {
    Info "去这个地址装扩展：$StoreUrl"
  }
}
