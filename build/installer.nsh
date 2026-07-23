!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var PhotoFlowDesktopShortcutCheckbox
Var PhotoFlowCreateDesktopShortcut
Var PhotoFlowGpuComponentCheckbox
Var PhotoFlowResearchComponentCheckbox
Var PhotoFlowOfficeMediaComponentCheckbox
Var PhotoFlowInstallGpuComponent
Var PhotoFlowInstallResearchComponent
Var PhotoFlowInstallOfficeMediaComponent
Var PhotoFlowGpuComponentArchive
Var PhotoFlowResearchComponentArchive
Var PhotoFlowOfficeMediaComponentArchive

!macro customPageAfterChangeDir
  Page custom PhotoFlowComponentPage PhotoFlowComponentPageLeave
  Page custom PhotoFlowShortcutPage PhotoFlowShortcutPageLeave
!macroend

Function PhotoFlowComponentPage
  StrCpy $PhotoFlowGpuComponentArchive ""
  StrCpy $PhotoFlowResearchComponentArchive ""
  StrCpy $PhotoFlowOfficeMediaComponentArchive ""
  ClearErrors
  FindFirst $0 $1 "$EXEDIR\PhotoFlow-team-retouch-*-win32-*.zip"
  IfErrors +3
    StrCpy $PhotoFlowGpuComponentArchive "$EXEDIR\$1"
    FindClose $0
  ClearErrors
  FindFirst $0 $1 "$EXEDIR\PhotoFlow-research-tools-*-win32-*.zip"
  IfErrors +3
    StrCpy $PhotoFlowResearchComponentArchive "$EXEDIR\$1"
    FindClose $0
  ClearErrors
  FindFirst $0 $1 "$EXEDIR\PhotoFlow-office-media-extractor-*-win32-*.zip"
  IfErrors +3
    StrCpy $PhotoFlowOfficeMediaComponentArchive "$EXEDIR\$1"
    FindClose $0

  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 0x000C 0 "STR:可选功能组件"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 0x000C 0 "STR:选择要从离线安装介质复制的组件"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 2u 100% 30u "组件不会放进基础安装包。请把 PhotoFlow-组件名-版本-win32-架构.zip 放在安装程序旁边；未选择或未找到时，基础程序仍可正常安装。"
  Pop $1
  ${NSD_CreateCheckbox} 0 40u 100% 14u "多人裁片修图（GPU/CPU 人物检测与高分辨率拼回）"
  Pop $PhotoFlowGpuComponentCheckbox
  ${NSD_Uncheck} $PhotoFlowGpuComponentCheckbox
  ${If} $PhotoFlowGpuComponentArchive == ""
  ${AndIfNot} ${FileExists} "$EXEDIR\components\team-retouch\component.json"
    ${NSD_SetText} $PhotoFlowGpuComponentCheckbox "多人裁片修图（安装介质中未找到）"
    EnableWindow $PhotoFlowGpuComponentCheckbox 0
  ${EndIf}

  ${NSD_CreateCheckbox} 0 64u 100% 14u "调研整理（视频分镜、图片去重与资料整理）"
  Pop $PhotoFlowResearchComponentCheckbox
  ${NSD_Uncheck} $PhotoFlowResearchComponentCheckbox
  ${If} $PhotoFlowResearchComponentArchive == ""
  ${AndIfNot} ${FileExists} "$EXEDIR\components\research-tools\component.json"
    ${NSD_SetText} $PhotoFlowResearchComponentCheckbox "调研整理（安装介质中未找到）"
    EnableWindow $PhotoFlowResearchComponentCheckbox 0
  ${EndIf}

  ${NSD_CreateCheckbox} 0 88u 100% 14u "Office 图片提取（提取 Word、PowerPoint、Excel 内嵌图片）"
  Pop $PhotoFlowOfficeMediaComponentCheckbox
  ${NSD_Uncheck} $PhotoFlowOfficeMediaComponentCheckbox
  ${If} $PhotoFlowOfficeMediaComponentArchive == ""
  ${AndIfNot} ${FileExists} "$EXEDIR\components\office-media-extractor\component.json"
    ${NSD_SetText} $PhotoFlowOfficeMediaComponentCheckbox "Office 图片提取（安装介质中未找到）"
    EnableWindow $PhotoFlowOfficeMediaComponentCheckbox 0
  ${EndIf}

  ${NSD_CreateLabel} 0 116u 100% 26u "仍兼容旧方式：把完整组件文件夹放在安装程序旁的 components 文件夹中。安装后也可以在照片流的“组件管理”中单独安装或卸载。"
  Pop $1
  nsDialogs::Show
FunctionEnd

Function PhotoFlowComponentPageLeave
  ${NSD_GetState} $PhotoFlowGpuComponentCheckbox $PhotoFlowInstallGpuComponent
  ${NSD_GetState} $PhotoFlowResearchComponentCheckbox $PhotoFlowInstallResearchComponent
  ${NSD_GetState} $PhotoFlowOfficeMediaComponentCheckbox $PhotoFlowInstallOfficeMediaComponent
FunctionEnd

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
  CreateDirectory "$INSTDIR\components"
  ${If} $PhotoFlowInstallGpuComponent == ${BST_CHECKED}
    ${If} $PhotoFlowGpuComponentArchive != ""
      nsisunz::Unzip "$PhotoFlowGpuComponentArchive" "$INSTDIR\components"
      Pop $0
      ${If} $0 != "success"
        MessageBox MB_OK|MB_ICONEXCLAMATION "多人裁片修图组件解压失败：$0"
      ${EndIf}
    ${ElseIf} ${FileExists} "$EXEDIR\components\team-retouch\component.json"
      CreateDirectory "$INSTDIR\components\team-retouch"
      CopyFiles /SILENT "$EXEDIR\components\team-retouch\*.*" "$INSTDIR\components\team-retouch"
    ${EndIf}
  ${EndIf}
  ${If} $PhotoFlowInstallResearchComponent == ${BST_CHECKED}
    ${If} $PhotoFlowResearchComponentArchive != ""
      nsisunz::Unzip "$PhotoFlowResearchComponentArchive" "$INSTDIR\components"
      Pop $0
      ${If} $0 != "success"
        MessageBox MB_OK|MB_ICONEXCLAMATION "调研整理组件解压失败：$0"
      ${EndIf}
    ${ElseIf} ${FileExists} "$EXEDIR\components\research-tools\component.json"
      CreateDirectory "$INSTDIR\components\research-tools"
      CopyFiles /SILENT "$EXEDIR\components\research-tools\*.*" "$INSTDIR\components\research-tools"
    ${EndIf}
  ${EndIf}
  ${If} $PhotoFlowInstallOfficeMediaComponent == ${BST_CHECKED}
    ${If} $PhotoFlowOfficeMediaComponentArchive != ""
      nsisunz::Unzip "$PhotoFlowOfficeMediaComponentArchive" "$INSTDIR\components"
      Pop $0
      ${If} $0 != "success"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Office 图片提取组件解压失败：$0"
      ${EndIf}
    ${ElseIf} ${FileExists} "$EXEDIR\components\office-media-extractor\component.json"
      CreateDirectory "$INSTDIR\components\office-media-extractor"
      CopyFiles /SILENT "$EXEDIR\components\office-media-extractor\*.*" "$INSTDIR\components\office-media-extractor"
    ${EndIf}
  ${EndIf}
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
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
