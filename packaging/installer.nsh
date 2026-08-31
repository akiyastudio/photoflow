!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef BUILD_UNINSTALLER
  !include "installer-directory.nsh"

  ; electron-builder 26 appends APP_FILENAME in instFilesPre whenever its built-in
  ; directory page is enabled. That also rewrites an explicit silent /D path, so
  ; the supported custom-page hook below owns the directory page instead.
  !ifdef allowToChangeInstallationDirectory
    !undef allowToChangeInstallationDirectory
  !endif
!endif

!define PhotoFlowTermsVersion "2026-08-30"
!define PhotoFlowPrivacyVersion "2026-08-30"

!ifdef BUILD_UNINSTALLER
Var PhotoFlowDeleteUserDataCheckbox
Var PhotoFlowDeleteUserData

!macro customUnInit
  StrCpy $PhotoFlowDeleteUserData ${BST_UNCHECKED}
!macroend

!macro customUnWelcomePage
  UninstPage custom un.PhotoFlowUninstallOptionsPage un.PhotoFlowUninstallOptionsPageLeave
!macroend

Function un.PhotoFlowUninstallOptionsPage
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 0x000C 0 "STR:卸载照片流"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 0x000C 0 "STR:选择是否同时清理本机用户数据"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 4u 100% 28u "卸载程序会移除照片流应用。默认保留设置和缓存，便于以后重新安装后继续使用。"
  Pop $1
  ${NSD_CreateCheckbox} 0 42u 100% 16u "同时清空照片流的用户数据和注册表"
  Pop $PhotoFlowDeleteUserDataCheckbox
  ${NSD_Uncheck} $PhotoFlowDeleteUserDataCheckbox
  ${NSD_CreateLabel} 0 68u 100% 46u "勾选后将永久删除设置、日志、索引、默认缩略图缓存、可选组件及高级环境。不会删除工作区、项目中的照片和视频，也不会删除用户指定到其他位置的缓存目录。"
  Pop $1

  nsDialogs::Show
FunctionEnd

Function un.PhotoFlowUninstallOptionsPageLeave
  ${NSD_GetState} $PhotoFlowDeleteUserDataCheckbox $PhotoFlowDeleteUserData
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
Var PhotoFlowDesktopShortcutCheckbox
Var PhotoFlowCreateDesktopShortcut
Var PhotoFlowExperienceProgramCheckbox
Var PhotoFlowExperienceProgram

; Keep electron-builder's native, scrollable license page, but separate the
; mandatory legal acceptance from the optional experience program consent.
; MUI uses control 1034 for acceptance and 1035 for rejection. The latter is
; converted into an independent checkbox; the former continues to gate Next.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PhotoFlowLicensePageShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE PhotoFlowLicensePageLeave

!macro customInit
  StrCpy $PhotoFlowExperienceProgram ${BST_UNCHECKED}
  StrCpy $PhotoFlowInstallDirectoryPolicy "normalize"
  IfSilent PhotoFlowPreserveRequestedInstallDirectory
  !ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
    StrCmp $perMachineInstallationFolder "" 0 PhotoFlowPreserveRequestedInstallDirectory
  !endif
  ${GetParameters} $R0
  ${GetOptions} $R0 "/D=" $R1
  IfErrors PhotoFlowInstallDirectoryPolicyReady 0

  PhotoFlowPreserveRequestedInstallDirectory:
  StrCpy $PhotoFlowInstallDirectoryPolicy "preserve"

  PhotoFlowInstallDirectoryPolicyReady:
!macroend

Function PhotoFlowLicensePageShow
  GetDlgItem $0 $HWNDPARENT 1034
  SendMessage $0 0x000C 0 "STR:我已阅读并同意《用户协议》和《隐私政策》（安装必选）"

  GetDlgItem $PhotoFlowExperienceProgramCheckbox $HWNDPARENT 1035
  System::Call 'USER32::GetWindowLong(i $PhotoFlowExperienceProgramCheckbox, i -16) i .r0'
  IntOp $0 $0 & 0xFFFFFFF0
  IntOp $0 $0 | 0x00000003
  System::Call 'USER32::SetWindowLong(i $PhotoFlowExperienceProgramCheckbox, i -16, i r0) i .r1'
  ; Give the converted control its own ID so the native license page does not
  ; interpret clicking the experience checkbox as choosing "reject".
  System::Call 'USER32::SetWindowLong(i $PhotoFlowExperienceProgramCheckbox, i -12, i 1201) i .r1'
  SendMessage $PhotoFlowExperienceProgramCheckbox 0x000C 0 "STR:自愿加入用户体验计划（可随时关闭）"
  ${NSD_Uncheck} $PhotoFlowExperienceProgramCheckbox
FunctionEnd

Function PhotoFlowLicensePageLeave
  ${NSD_GetState} $PhotoFlowExperienceProgramCheckbox $PhotoFlowExperienceProgram
FunctionEnd

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PhotoFlowDirectoryPagePre
  !insertmacro MUI_PAGE_DIRECTORY
  Page custom PhotoFlowShortcutPage PhotoFlowShortcutPageLeave
!macroend

Function PhotoFlowDirectoryPagePre
  StrCmp $PhotoFlowInstallDirectoryPolicy "preserve" PhotoFlowSkipDirectoryPage
  Return

  PhotoFlowSkipDirectoryPage:
  Abort
FunctionEnd

Function PhotoFlowShortcutPage
  Call PhotoFlowApplyInstallDirectoryPolicy

  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 0x000C 0 "STR:安装选项"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 0x000C 0 "STR:选择要创建的快捷方式"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 4u 100% 22u "可以稍后从开始菜单启动照片流。"
  Pop $1
  ${NSD_CreateCheckbox} 0 34u 100% 14u "在桌面创建照片流快捷方式"
  Pop $PhotoFlowDesktopShortcutCheckbox
  ${NSD_Uncheck} $PhotoFlowDesktopShortcutCheckbox

  nsDialogs::Show
FunctionEnd

Function PhotoFlowShortcutPageLeave
  ${NSD_GetState} $PhotoFlowDesktopShortcutCheckbox $PhotoFlowCreateDesktopShortcut
FunctionEnd

!macro customInstall
  IfSilent PhotoFlowSkipConsentReceipt
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  CreateDirectory "$APPDATA\Photoflow"
  WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "SchemaVersion" "2"
  WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "Interactive" "1"
  WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "TermsVersion" "${PhotoFlowTermsVersion}"
  WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "PrivacyVersion" "${PhotoFlowPrivacyVersion}"
  WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "InstallerVersion" "${VERSION}"
  ${If} $PhotoFlowExperienceProgram == ${BST_CHECKED}
    WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "ExperienceProgram" "1"
  ${Else}
    WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "ExperienceProgram" "0"
  ${EndIf}
  WriteINIStr "$APPDATA\Photoflow\install-consent.ini" "Consent" "AcceptedAtLocal" "$2-$1-$0T$4:$5:$6"
  PhotoFlowSkipConsentReceipt:
  ${If} $PhotoFlowCreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${If} $PhotoFlowDeleteUserData == ${BST_CHECKED}
    DetailPrint "正在清理照片流用户数据和专属运行环境..."
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --terminate PhotoFlowNative'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --unregister PhotoFlowNative'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --terminate PhotoflowLab'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --unregister PhotoflowLab'
    Pop $0

    RMDir /r "$APPDATA\Photoflow"
    RMDir /r "$LOCALAPPDATA\PhotoFlow"
    RMDir /r "$TEMP\photoflow"
    RMDir /r "$TEMP\Photoflow-shell-new-icons"

    DeleteRegKey HKCU "Software\PhotoFlow"
    DeleteRegKey HKCU "Software\Photoflow"
    DeleteRegKey HKCU "Software\Classes\photoflow"
    DeleteRegKey HKCU "Software\Classes\com.photoflow.toolkit"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.photoflow.toolkit"
    DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Photoflow.exe"
  ${EndIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
