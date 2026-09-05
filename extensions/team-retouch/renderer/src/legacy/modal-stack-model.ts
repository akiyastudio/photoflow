export type ModalLayer = { token: number; dismissible: boolean; close: () => void };

export const createModalStack = () => {
  let nextToken = 1;
  const layers: ModalLayer[] = [];
  return {
    register(close: () => void, dismissible = true) {
      const layer = { token: nextToken++, close, dismissible };
      layers.push(layer);
      return layer.token;
    },
    update(token: number, close: () => void, dismissible: boolean) {
      const layer = layers.find(item => item.token === token);
      if (layer) { layer.close = close; layer.dismissible = dismissible; }
    },
    unregister(token: number) {
      const index = layers.findIndex(item => item.token === token);
      if (index >= 0) layers.splice(index, 1);
    },
    escape() {
      const layer = layers.at(-1);
      if (!layer || !layer.dismissible) return false;
      layer.close();
      return true;
    },
    topToken: () => layers.at(-1)?.token,
    size: () => layers.length,
  };
};

export const nextFocusIndex = (length: number, current: number, backwards = false) => {
  if (length <= 0) return -1;
  if (current < 0) return backwards ? length - 1 : 0;
  return (current + (backwards ? length - 1 : 1)) % length;
};
