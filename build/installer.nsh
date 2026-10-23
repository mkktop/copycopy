; 1.2 stored data inside the installation directory. Its uninstaller deletes
; that entire directory, even during an upgrade. Copy it before invoking the
; old uninstaller. Never merge two libraries or remove a source on failure.
!macro checkLegacyDestination directory
  ${If} ${FileExists} "$copycopyLegacyRoot\${directory}\*.*"
    ${If} ${FileExists} "$copycopyDataRoot\${directory}\*.*"
      MessageBox MB_OK|MB_ICONSTOP "CopyCopy found data in both the old installation and the user data folder. Please back up and resolve these folders before upgrading:$\r$\n$copycopyLegacyRoot\${directory}$\r$\n$copycopyDataRoot\${directory}" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro copyLegacyDirectory directory
  ${If} ${FileExists} "$copycopyLegacyRoot\${directory}\*.*"
    nsExec::ExecToStack '"$SYSDIR\robocopy.exe" "$copycopyLegacyRoot\${directory}" "$copycopyDataRoot\${directory}" /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1'
    Pop $0
    Pop $1
    ${If} $0 == "error"
    ${OrIf} $0 == "timeout"
    ${OrIf} $0 >= 8
      MessageBox MB_OK|MB_ICONSTOP "CopyCopy could not preserve the old data. Installation has stopped without uninstalling the old version. Please check disk space and folder permissions.$\r$\n$copycopyLegacyRoot\${directory}" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  Var /GLOBAL copycopyLegacyRoot
  Var /GLOBAL copycopyDataRoot
  StrCpy $copycopyLegacyRoot "$perUserInstallationFolder"
  ${If} $copycopyLegacyRoot == ""
    StrCpy $copycopyLegacyRoot "$perMachineInstallationFolder"
  ${EndIf}
  SetShellVarContext current
  StrCpy $copycopyDataRoot "$APPDATA\CopyCopy\data"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  ${If} $copycopyLegacyRoot != ""
    ${If} ${FileExists} "$copycopyLegacyRoot\config\*.*"
    ${OrIf} ${FileExists} "$copycopyLegacyRoot\out\*.*"
    ${OrIf} ${FileExists} "$copycopyLegacyRoot\logs\*.*"
    ${OrIf} ${FileExists} "$copycopyLegacyRoot\cache\*.*"
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $0
      ${If} $0 == 0
        MessageBox MB_OK|MB_ICONSTOP "Please close CopyCopy and run this installer again so your manga and settings can be preserved." /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      !insertmacro checkLegacyDestination "config"
      !insertmacro checkLegacyDestination "out"
      !insertmacro checkLegacyDestination "logs"
      !insertmacro checkLegacyDestination "cache"
      !insertmacro copyLegacyDirectory "config"
      !insertmacro copyLegacyDirectory "out"
      !insertmacro copyLegacyDirectory "logs"
      !insertmacro copyLegacyDirectory "cache"
    ${EndIf}
  ${EndIf}
!macroend
