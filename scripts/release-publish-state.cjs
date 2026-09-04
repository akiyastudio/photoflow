const runPublishStateMachine = async ({ writeInitialPending, prepareLocalRecord, publishRemote, promoteLocalRecord, assertArtifactsUnchanged, writeState }) => {
  let remoteSaved = false;
  let phase = 'pending';
  await writeInitialPending({ state: 'pending' });
  await prepareLocalRecord();
  try {
    await publishRemote();
    remoteSaved = true;
    phase = 'local-promotion';
    await promoteLocalRecord();
    phase = 'artifact-fence';
    await assertArtifactsUnchanged();
    phase = 'committed';
    await writeState({ state: 'committed' });
    return { state: 'committed' };
  } catch (error) {
    if (!remoteSaved) throw error;
    const state = phase === 'artifact-fence' ? 'remote-saved-artifacts-changed' : 'remote-saved-local-pending';
    try { await writeState({ state, phase, reason: error.message || String(error) }); }
    catch (stateError) { throw new Error(`线上结果已确认，但本地状态记录失败；禁止重发：${stateError.message || stateError}`, { cause: error }); }
    throw Object.assign(new Error(`线上结果已确认，但发布未完成（${state}）；禁止重发：${error.message || error}`), { releaseState: state, cause: error });
  }
};

module.exports = { runPublishStateMachine };
