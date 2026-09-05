import type { TeamProjectPhoto } from './legacy-types';

type Json = Record<string, unknown>;

const object = (value: unknown, label: string): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是对象`);
  return value as Json;
};

const requiredString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串`);
  return value;
};

/** Validate the current project DTO at the renderer trust boundary. */
export const assertTeamProjectPhoto = (value: unknown, index = 0): TeamProjectPhoto => {
  const photo = object(value, `photos[${index}]`);
  requiredString(photo.photoId, `photos[${index}].photoId`);
  requiredString(photo.baseVersionId, `photos[${index}].baseVersionId`);
  requiredString(photo.displayName, `photos[${index}].displayName`);
  if (typeof photo.relativePath !== 'string') throw new TypeError(`photos[${index}].relativePath 必须是字符串`);
  if (!Array.isArray(photo.tasks)) throw new TypeError(`photos[${index}].tasks 必须是数组`);
  for (const [taskIndex, rawTask] of photo.tasks.entries()) {
    const task = object(rawTask, `photos[${index}].tasks[${taskIndex}]`);
    requiredString(task.id, `photos[${index}].tasks[${taskIndex}].id`);
    if (!Array.isArray(task.members)) throw new TypeError(`photos[${index}].tasks[${taskIndex}].members 必须是数组`);
  }
  if (Object.hasOwn(photo, 'name')) throw new TypeError(`photos[${index}].name 不是 current DTO 字段，请使用 displayName`);
  return value as TeamProjectPhoto;
};

export const assertTeamProjectPhotos = (value: unknown): TeamProjectPhoto[] => {
  if (!Array.isArray(value)) throw new TypeError('photos 必须是数组');
  return value.map(assertTeamProjectPhoto);
};
