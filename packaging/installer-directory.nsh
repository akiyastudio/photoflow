!ifndef PHOTOFLOW_INSTALL_DIRECTORY_POLICY_INCLUDED
!define PHOTOFLOW_INSTALL_DIRECTORY_POLICY_INCLUDED
!define PhotoFlowInstallFolderName "照片流"

Var PhotoFlowInstallDirectoryPolicy

Function PhotoFlowNormalizeDriveInstallDirectory
  Exch $0
  Push $1

  StrCpy $1 $0 1 1
  StrCmp $1 ":" 0 PhotoFlowNormalizeDriveInstallDirectoryDone
  StrCpy $0 $0 1
  StrCpy $0 "$0:\Program Files\${PhotoFlowInstallFolderName}"

  PhotoFlowNormalizeDriveInstallDirectoryDone:
  Pop $1
  Exch $0
FunctionEnd

Function PhotoFlowApplyInstallDirectoryPolicy
  StrCmp $PhotoFlowInstallDirectoryPolicy "normalize" 0 PhotoFlowApplyInstallDirectoryPolicyDone
  Push $INSTDIR
  Call PhotoFlowNormalizeDriveInstallDirectory
  Pop $INSTDIR

  PhotoFlowApplyInstallDirectoryPolicyDone:
FunctionEnd

!endif
