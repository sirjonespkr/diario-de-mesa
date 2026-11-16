Option Explicit
Dim sh, fso, pasta
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
' Roda o atalho escondido (sem janela preta).
sh.Run "powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & pasta & "\DiarioDeMesa-Atalho.ps1""", 0, False
