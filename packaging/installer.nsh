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

!define PhotoFlowTermsVersion "2026-08-31"
!define PhotoFlowPrivacyVersion "2026-08-31"

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
Var PhotoFlowLicensePage
Var PhotoFlowNativeConsentControl
Var PhotoFlowExperienceProgramCheckbox
Var PhotoFlowExperienceProgram

; Keep electron-builder's native, scrollable license page, but separate the
; legal acceptance from the experience program consent. NSIS creates one real
; checkbox, which remains checked but hidden to unlock the native action
; button. A separate Win32 checkbox at the same position owns the experience
; program choice, so toggling it cannot gate installation.
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "我愿意加入用户体验改善计划"
!define MUI_LICENSEPAGE_BUTTON "我同意"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PhotoFlowLicensePageShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE PhotoFlowLicensePageLeave

!macro customInit
  StrCpy $PhotoFlowExperienceProgram ${BST_CHECKED}
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
  FindWindow $PhotoFlowLicensePage "#32770" "" $HWNDPARENT
  GetDlgItem $0 $PhotoFlowLicensePage 1006
  SendMessage $0 0x000C 0 "STR:如果你接受协议中的条款，请单击 [我同意] 继续安装。"
  GetDlgItem $PhotoFlowNativeConsentControl $PhotoFlowLicensePage 1034
  GetDlgItem $PhotoFlowExperienceProgramCheckbox $PhotoFlowLicensePage 1201

  ; Keep NSIS's own consent checkbox selected so "我同意" remains enabled.
  ${NSD_GetState} $PhotoFlowNativeConsentControl $0
  ${If} $0 != ${BST_CHECKED}
    SendMessage $PhotoFlowNativeConsentControl 0x00F5 0 0
  ${EndIf}

  ${If} $PhotoFlowExperienceProgramCheckbox == 0
    ; Copy the native control's DPI-aware rectangle, then create an unrelated
    ; auto-checkbox with a private control ID at exactly the same position.
    System::Alloc 16
    Pop $R0
    System::Call 'USER32::GetWindowRect(i $PhotoFlowNativeConsentControl, i $R0)'
    System::Call 'USER32::MapWindowPoints(i 0, i $PhotoFlowLicensePage, i $R0, i 2)'
    System::Call '*$R0(i .r1, i .r2, i .r3, i .r4)'
    IntOp $3 $3 - $1
    IntOp $4 $4 - $2
    System::Call 'USER32::CreateWindowExW(i 0, w "Button", w "我愿意加入用户体验改善计划", i 0x50010003, i r1, i r2, i r3, i r4, i $PhotoFlowLicensePage, i 1201, i 0, i 0) i .r5'
    StrCpy $PhotoFlowExperienceProgramCheckbox $5
    SendMessage $PhotoFlowNativeConsentControl 0x0031 0 0 $6
    SendMessage $PhotoFlowExperienceProgramCheckbox 0x0030 $6 1
    System::Free $R0
  ${EndIf}

  ShowWindow $PhotoFlowNativeConsentControl ${SW_HIDE}
  SendMessage $PhotoFlowExperienceProgramCheckbox 0x000C 0 "STR:我愿意加入用户体验改善计划"
  ${If} $PhotoFlowExperienceProgram == ${BST_CHECKED}
    ${NSD_Check} $PhotoFlowExperienceProgramCheckbox
  ${Else}
    ${NSD_Uncheck} $PhotoFlowExperienceProgramCheckbox
  ${EndIf}
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

  ; Per-machine elevation can make $APPDATA resolve to the administrator's
  ; profile. Store the same receipt beside the packaged application so the
  ; normal user process can import it without showing a duplicate consent page.
  CreateDirectory "$INSTDIR\resources"
  WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "SchemaVersion" "2"
  WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "Interactive" "1"
  WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "TermsVersion" "${PhotoFlowTermsVersion}"
  WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "PrivacyVersion" "${PhotoFlowPrivacyVersion}"
  WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "InstallerVersion" "${VERSION}"
  ${If} $PhotoFlowExperienceProgram == ${BST_CHECKED}
    WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "ExperienceProgram" "1"
  ${Else}
    WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "ExperienceProgram" "0"
  ${EndIf}
  WriteINIStr "$INSTDIR\resources\install-consent.ini" "Consent" "AcceptedAtLocal" "$2-$1-$0T$4:$5:$6"
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
