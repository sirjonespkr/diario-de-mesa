# Diário de Mesa: atalho para mandar prints de mãos para a Caixa de entrada do site.
# - NÃO usa IA (não gasta nada) e NÃO mexe no Win+Shift+S.
# - Só envia quando você aperta um dos atalhos abaixo.
# - Fica rodando escondido, com um ícone perto do relógio (clique com o botão direito para as opções).

# ===================== Configuração (pode mudar) =====================
$SITE   = "https://diario-de-mesa-gamma.vercel.app"
$SB_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co"
$SB_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374"

$JUNTAR_MINUTOS = 1          # prints com menos de X minutos de diferença entram na mesma mão
$PEDIR_LEGENDA  = $false     # $true: abre uma caixinha para a legenda depois de cada print (rouba o foco da mesa!)

# Atalhos, perto do Win+Shift+S. Para cada ação, usa a primeira opção que estiver livre no PC.
# Modificadores: Win, Ctrl, Shift, Alt. Tecla: letra, número ou F1..F12. Ex.: "Win+Shift+A".
$ATALHOS = @(
  @{ Nome = "print"; Opcoes = @("Win+Shift+A", "Win+Shift+Q", "Ctrl+Shift+F1") },   # print da mão (junta com a mão atual)
  @{ Nome = "nova";  Opcoes = @("Win+Shift+Z", "Win+Shift+W", "Ctrl+Shift+F2") },   # print começando uma mão nova
  @{ Nome = "lobby"; Opcoes = @("Win+Shift+X", "Win+Shift+E", "Ctrl+Shift+F3") }    # print do lobby da mão atual
)
# =====================================================================

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic

# só uma cópia rodando
$created = $false
$script:mutex = [System.Threading.Mutex]::new($true, "DiarioDeMesaAtalho", [ref]$created)
if (-not $created) {
  [System.Windows.Forms.MessageBox]::Show("O atalho do Diário de Mesa já está rodando (veja o ícone perto do relógio).", "Diário de Mesa") | Out-Null
  exit
}

$DATA = Join-Path $env:APPDATA "DiarioDeMesa"
New-Item -ItemType Directory -Force -Path $DATA | Out-Null
$SESSION_FILE = Join-Path $DATA "sessao.dat"
$STATE_FILE   = Join-Path $DATA "estado.json"
$LOG_FILE     = Join-Path $DATA "log.txt"
function Log($msg) { try { Add-Content -Path $LOG_FILE -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg) -Encoding UTF8 } catch {} }

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class HotkeyWindow : Form {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  public event EventHandler<HotkeyArgs> Hotkey;
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312 && Hotkey != null) Hotkey(this, new HotkeyArgs(m.WParam.ToInt32()));
    base.WndProc(ref m);
  }
  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
}
public class HotkeyArgs : EventArgs { public int Id; public HotkeyArgs(int id) { Id = id; } }
"@

# ---------------- ícone e avisos ----------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = "Diário de Mesa: atalho de prints"
$tray.Visible = $true
function Notify($title, $text, $err = $false) {
  $icon = if ($err) { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Info }
  $tray.ShowBalloonTip(2500, $title, $text, $icon)
}

# ---------------- estado (mão atual) ----------------
function Load-State {
  if (Test-Path $STATE_FILE) { try { return Get-Content $STATE_FILE -Raw | ConvertFrom-Json } catch {} }
  return [pscustomobject]@{ handId = $null; lastTicks = 0; count = 0 }
}
function Save-State($st) { $st | ConvertTo-Json -Compress | Set-Content -Path $STATE_FILE -Encoding UTF8 }

# ---------------- login (sessão própria do PC, guardada criptografada pelo Windows) ----------------
function Save-Session([string]$rt) {
  $enc = ConvertTo-SecureString $rt -AsPlainText -Force | ConvertFrom-SecureString
  [IO.File]::WriteAllText($SESSION_FILE, $enc)
}
function Load-Session {
  if (-not (Test-Path $SESSION_FILE)) { return $null }
  try {
    # .Trim(): o arquivo termina com uma quebra de linha, que impedia de ler a sessão (e pedia login toda vez)
    $txt = (Get-Content $SESSION_FILE -Raw).Trim()
    $ss = ConvertTo-SecureString $txt
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
  } catch { Log "não li a sessão salva: $($_.Exception.Message)"; return $null }
}
function Show-Login([string]$msg) {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = "Diário de Mesa: entrar"; $f.Width = 380; $f.Height = 250; $f.FormBorderStyle = "FixedDialog"
  $f.StartPosition = "CenterScreen"; $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.TopMost = $true
  $l = New-Object System.Windows.Forms.Label; $l.Text = $msg; $l.SetBounds(16, 12, 340, 36)
  $le = New-Object System.Windows.Forms.Label; $le.Text = "E-mail"; $le.SetBounds(16, 52, 340, 18)
  $e = New-Object System.Windows.Forms.TextBox; $e.SetBounds(16, 72, 330, 24)
  $lp = New-Object System.Windows.Forms.Label; $lp.Text = "Senha"; $lp.SetBounds(16, 102, 340, 18)
  $p = New-Object System.Windows.Forms.TextBox; $p.SetBounds(16, 122, 330, 24); $p.UseSystemPasswordChar = $true
  $ok = New-Object System.Windows.Forms.Button; $ok.Text = "Entrar"; $ok.SetBounds(246, 162, 100, 30); $ok.DialogResult = "OK"
  $f.Controls.AddRange(@($l, $le, $e, $lp, $p, $ok)); $f.AcceptButton = $ok
  if ($f.ShowDialog() -eq "OK" -and $e.Text.Trim() -and $p.Text) { return @{ email = $e.Text.Trim(); pass = $p.Text } }
  return $null
}
function Post-Json([string]$url, $body, [string]$token, [string]$prefer) {
  $h = @{ apikey = $SB_KEY }
  if ($token) { $h["Authorization"] = "Bearer $token" }
  if ($prefer) { $h["Prefer"] = $prefer }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress -Depth 5))
  return Invoke-RestMethod -Method Post -Uri $url -Headers $h -ContentType "application/json; charset=utf-8" -Body $bytes
}
$script:access = $null; $script:accessExp = [DateTime]::MinValue; $script:uid = $null
function Use-Token($r) {
  $script:access = $r.access_token
  $script:accessExp = (Get-Date).AddSeconds([int]$r.expires_in - 60)
  $script:uid = $r.user.id
  Save-Session $r.refresh_token
}
function Get-Access {
  if ($script:access -and (Get-Date) -lt $script:accessExp) { return $script:access }
  $rt = Load-Session
  if ($rt) {
    try { Use-Token (Post-Json "$SB_URL/auth/v1/token?grant_type=refresh_token" @{ refresh_token = $rt }); return $script:access }
    catch { Log "refresh falhou: $($_.Exception.Message)"; Remove-Item $SESSION_FILE -ErrorAction SilentlyContinue }
  }
  $msg = "Entre com a mesma conta do site (só na primeira vez). A senha não fica salva."
  for ($i = 0; $i -lt 3; $i++) {
    $cred = Show-Login $msg
    if (-not $cred) { throw "login cancelado" }
    try { Use-Token (Post-Json "$SB_URL/auth/v1/token?grant_type=password" @{ email = $cred.email; password = $cred.pass }); return $script:access }
    catch { $msg = "E-mail ou senha incorretos. Tente de novo." }
  }
  throw "não foi possível entrar"
}

# ---------------- captura ----------------
function Capture-Snip {
  $before = [HotkeyWindow]::GetClipboardSequenceNumber()
  Start-Process "ms-screenclip:"
  # espera o recorte por até 25 s; se você apertar um atalho de novo, para de esperar e começa o novo recorte
  $limit = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $limit) {
    [System.Windows.Forms.Application]::DoEvents()
    if ($script:cancelWait) { return $null }
    Start-Sleep -Milliseconds 150
    if ([HotkeyWindow]::GetClipboardSequenceNumber() -ne $before) {
      try { if ([System.Windows.Forms.Clipboard]::ContainsImage()) { return [System.Windows.Forms.Clipboard]::GetImage() } } catch {}
    }
  }
  return $null
}
function To-Jpeg($img, [int]$max) {
  $w = $img.Width; $h = $img.Height
  $k = [Math]::Min(1.0, $max / [double][Math]::Max($w, $h))
  $bmp = New-Object System.Drawing.Bitmap ([int]($w * $k)), ([int]($h * $k))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $bmp.Width, $bmp.Height); $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]90)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, $codec, $ep); $bmp.Dispose()
  # a vírgula impede o PowerShell de "desmontar" os bytes em uma lista de números (isso corrompia a imagem)
  return ,($ms.ToArray())
}

# ---------------- envio ----------------
function New-Hand([string]$token) {
  $r = @(Post-Json "$SB_URL/rest/v1/hands" @{ status = "inbox"; source = "atalho"; played_on = (Get-Date).ToString("yyyy-MM-dd") } $token "return=representation")
  return $r[0].id
}
function Send-Print([string]$kind, [bool]$forceNew) {
  $img = Capture-Snip
  if (-not $img) { return }   # recorte cancelado: não envia nada
  $caption = $null
  if ($kind -eq "lobby") { $caption = "lobby" }
  elseif ($PEDIR_LEGENDA) { $caption = [Microsoft.VisualBasic.Interaction]::InputBox("Legenda do print (opcional):", "Diário de Mesa", "") }

  $token = Get-Access
  $st = Load-State
  $now = (Get-Date).Ticks
  $minutes = if ($st.lastTicks) { ($now - [long]$st.lastTicks) / 600000000.0 } else { 9999 }
  $isNew = $forceNew -or (-not $st.handId) -or ($kind -ne "lobby" -and $minutes -gt $JUNTAR_MINUTOS) -or ($kind -eq "lobby" -and $minutes -gt 120)
  if ($isNew) { $st.handId = New-Hand $token; $st.count = 0 }

  [byte[]]$bytes = To-Jpeg $img $(if ($kind -eq "lobby") { 2400 } else { 2000 })
  if ($bytes.Length -lt 1000) { throw "a imagem do recorte veio vazia" }
  $img.Dispose()
  $path = "{0}/{1}/{2}-{3}.jpg" -f $script:uid, $st.handId, (Get-Date).ToString("yyyyMMddHHmmssfff"), (Get-Random -Maximum 99999)
  $h = @{ apikey = $SB_KEY; Authorization = "Bearer $token"; "x-upsert" = "false" }
  try {
    Invoke-RestMethod -Method Post -Uri "$SB_URL/storage/v1/object/hands/$path" -Headers $h -ContentType "image/jpeg" -Body $bytes | Out-Null
    $row = @{ hand_id = $st.handId; path = $path; sort = $(if ($kind -eq "lobby") { 999 } else { [int]$st.count }); kind = $(if ($kind -eq "lobby") { "lobby" } else { "mesa" }) }
    if ($caption) { $row["caption"] = $caption }
    Post-Json "$SB_URL/rest/v1/hand_images" $row $token "" | Out-Null
  } catch {
    if (-not $isNew) {
      # a mão foi apagada no site: começa outra e tenta de novo uma vez
      Log "mão antiga indisponível, criando nova: $($_.Exception.Message)"
      $st.handId = New-Hand $token; $st.count = 0
      $path = "{0}/{1}/{2}-{3}.jpg" -f $script:uid, $st.handId, (Get-Date).ToString("yyyyMMddHHmmssfff"), (Get-Random -Maximum 99999)
      Invoke-RestMethod -Method Post -Uri "$SB_URL/storage/v1/object/hands/$path" -Headers $h -ContentType "image/jpeg" -Body $bytes | Out-Null
      $row = @{ hand_id = $st.handId; path = $path; sort = 0; kind = $(if ($kind -eq "lobby") { "lobby" } else { "mesa" }) }
      if ($caption) { $row["caption"] = $caption }
      Post-Json "$SB_URL/rest/v1/hand_images" $row $token "" | Out-Null
      $isNew = $true
    } else { throw }
  }
  if ($kind -ne "lobby") { $st.count = [int]$st.count + 1; $st.lastTicks = $now }
  Save-State $st
  if ($kind -eq "lobby") { Notify "Lobby enviado" "Anexado à mão atual na Caixa de entrada." }
  elseif ($isNew) { Notify "Mão nova na Caixa de entrada" "Print 1 enviado. Os próximos em até $JUNTAR_MINUTOS min entram na mesma mão." }
  else { Notify "Print $($st.count) enviado" "Junto com a mão atual na Caixa de entrada." }
}

# ---------------- atalhos ----------------
$win = New-Object HotkeyWindow
$null = $win.Handle
$MODS = @{ alt = 1; ctrl = 2; control = 2; shift = 4; win = 8 }
$NOMES = @{ print = "mão"; nova = "mão nova"; lobby = "lobby" }
$registered = @(); $failed = @()
for ($i = 0; $i -lt $ATALHOS.Count; $i++) {
  $a = $ATALHOS[$i]; $ok = $false
  foreach ($combo in $a.Opcoes) {
    $parts = $combo.Split("+") | ForEach-Object { $_.Trim() }
    $mod = 0x4000   # sem repetição ao segurar
    foreach ($m in $parts[0..($parts.Count - 2)]) { $mod = $mod -bor $MODS[$m.ToLower()] }
    $key = $parts[-1]
    if ($key -match '^[0-9]$') { $key = "D$key" }
    try { $vk = [int][System.Windows.Forms.Keys]$key } catch { continue }
    if ([HotkeyWindow]::RegisterHotKey($win.Handle, $i + 1, $mod, $vk)) { $registered += "$($NOMES[$a.Nome]): $combo"; $ok = $true; break }
  }
  if (-not $ok) { $failed += $NOMES[$a.Nome] }
}
$script:busy = $false; $script:pending = $null; $script:cancelWait = $false
function Run-Action([string]$nome) {
  switch ($nome) {
    "print" { Send-Print "mesa" $false }
    "nova"  { Send-Print "mesa" $true }
    "lobby" { Send-Print "lobby" $false }
  }
}
$win.add_Hotkey({
  param($s, $e)
  $nome = $ATALHOS[$e.Id - 1].Nome
  # já esperando um recorte (ex.: você cancelou com Esc)? guarda o novo pedido e para de esperar o antigo
  if ($script:busy) { $script:pending = $nome; $script:cancelWait = $true; return }
  $script:busy = $true
  try {
    do {
      $script:pending = $null; $script:cancelWait = $false
      try { Run-Action $nome }
      catch {
        Log "erro: $($_.Exception.Message)"
        Notify "Não deu para enviar o print" $_.Exception.Message $true
      }
      $nome = $script:pending
    } while ($nome)
  } finally { $script:busy = $false; $script:cancelWait = $false; $script:pending = $null }
})

# ---------------- menu do ícone ----------------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$null = $menu.Items.Add("Abrir Caixa de entrada", $null, { Start-Process "$SITE/#entrada" })
$null = $menu.Items.Add("Próximo print começa mão nova", $null, { $st = Load-State; $st.handId = $null; Save-State $st; Notify "Ok" "O próximo print vai começar uma mão nova." })
$null = $menu.Items.Add("Sair da conta neste PC", $null, { Remove-Item $SESSION_FILE -ErrorAction SilentlyContinue; $script:access = $null; Notify "Saiu da conta" "No próximo print ele pede o login de novo." })
$null = $menu.Items.Add("-")
$null = $menu.Items.Add("Fechar o atalho", $null, { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Start-Process "$SITE/#entrada" })

# login logo ao iniciar (só pede na primeira vez)
try { $null = Get-Access } catch { Log "login: $($_.Exception.Message)" }

$txt = if ($registered.Count) { "Ativos: " + ($registered -join ", ") } else { "Nenhum atalho ficou ativo." }
if ($failed.Count) { $txt += ". Sem atalho livre para: " + ($failed -join ", ") }
Notify "Diário de Mesa: atalho ligado" $txt ($failed.Count -gt 0)
Log "iniciado. $txt"

[System.Windows.Forms.Application]::Run($win)

for ($i = 1; $i -le $ATALHOS.Count; $i++) { [HotkeyWindow]::UnregisterHotKey($win.Handle, $i) | Out-Null }
$tray.Dispose()
