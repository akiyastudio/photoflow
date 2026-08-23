type ConsentDialog = { choice: (options: { title: string; message: string; detail?: string; choices: Array<{ value: string; label: string }>; cancelLabel?: string; defaultValue?: string; cancelDefault?: boolean }) => Promise<string | null> };
const key = 'photoflow:team-retouch:face-consent-v1';
export const ensureFaceRecognitionConsent = async (dialog: ConsentDialog) => {
  if (localStorage.getItem(key) === 'granted') return true;
  const choice = await dialog.choice({
    title: '单独同意处理人脸信息',
    message: '跨照片人物身份识别会在本机提取人脸身份特征和身体外观特征，用于生成同一人物的候选分组。照片和特征不会因该功能自动上传。',
    detail: '人脸信息属于敏感个人信息。请确认已取得被摄者或其监护人的合法授权；自动结果仅供候选，必须人工确认。不同意不会影响普通人物检测、裁图和手工标记。',
    choices: [{ value: 'agree', label: '单独同意并继续' }], cancelLabel: '暂不启用', defaultValue: 'agree',
  });
  if (choice !== 'agree') return false;
  localStorage.setItem(key, 'granted');
  return true;
};
