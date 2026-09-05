class ComponentLifecycleCoordinator {
  constructor({ blocker = () => false } = {}) { this.states = new Map(); this.globalQuiescing = false; this.blocker = blocker; }
  assertAvailable(componentId) {
    const id = String(componentId || ''); const state = this.states.get(id);
    if (this.blocker(id)) { const error = new Error(`组件 ${id} 的旧进程树尚未确认清空，请重试关闭后台进程`); error.code = 'COMPONENT_TERMINATION_UNCONFIRMED'; throw error; }
    if (this.globalQuiescing || state) { const error = new Error(`组件 ${id} 正在${state?.operation || '退出协调'}，暂不接受新工作`); error.code = 'COMPONENT_QUIESCING'; throw error; }
  }
  acquire(componentId, operation, { stopOnly = false } = {}) {
    const id = String(componentId || '').trim(); if (!id) throw new Error('组件 ID 不能为空');
    if (!(stopOnly && this.blocker(id))) this.assertAvailable(id); else if (this.globalQuiescing || this.states.has(id)) { const error=new Error('组件终止重试正在进行');error.code='COMPONENT_QUIESCING';throw error; }
    const state = { operation: String(operation || 'transition'), token: Symbol(id) }; this.states.set(id, state);
    let released = false; const lease = { componentId: id, operation: state.operation, token: state.token, release: () => { if (!released && this.states.get(id)?.token === state.token) this.states.delete(id); released = true; } }; return lease;
  }
  beginApplicationQuit() { if (this.globalQuiescing || this.states.size) return false; this.globalQuiescing = true; return true; }
  cancelApplicationQuit() { this.globalQuiescing = false; }
  isQuiescing(componentId) { return this.globalQuiescing || this.states.has(String(componentId || '')); }
  currentLease(componentId) { const state=this.states.get(String(componentId||''));return state?{componentId:String(componentId),token:state.token}:null; }
  assertLaunchAllowed(componentId, lease) {
    const id=String(componentId||'');const state=this.states.get(id);
    if(this.globalQuiescing){const error=new Error('应用正在退出，禁止启动新的组件进程');error.code='COMPONENT_QUIESCING';throw error;}
    if(state&&lease?.componentId===id&&lease?.token===state.token)return;
    this.assertAvailable(id);
  }
}
module.exports = { ComponentLifecycleCoordinator };
