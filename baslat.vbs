Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir

bubbleExe = currentDir & "\node_modules\electron\dist\whatsapp-bubble.exe"
electronExe = currentDir & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(bubbleExe) Then
    WshShell.Run """" & bubbleExe & """ """ & currentDir & """", 0, False
ElseIf fso.FileExists(electronExe) Then
    WshShell.Run """" & electronExe & """ """ & currentDir & """", 0, False
Else
    WshShell.Run "cmd /c npm start", 0, False
End If

Set WshShell = Nothing
Set fso = Nothing
