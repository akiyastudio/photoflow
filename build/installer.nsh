!include "nsDialogs.nsh"
!include "LogicLib.nsh"

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

!macro customPageAfterChangeDir
  Page custom PhotoFlowShortcutPage PhotoFlowShortcutPageLeave
!macroend

Function PhotoFlowShortcutPage
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
