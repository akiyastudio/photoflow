# User actions

The setup is automated except for actions that require personal access or visual
judgement.

## Optional later: SAM 3 checkpoint

1. Sign in to Hugging Face and request/accept access to `facebook/sam3`.
2. Create a read-only Hugging Face token.
3. In PowerShell, enter the isolated distribution:

   ```powershell
   wsl.exe -d PhotoflowNative -u photoflowlab
   ```

4. In the WSL shell, authenticate interactively:

   ```bash
   /home/photoflowlab/miniforge3/envs/sam3/bin/hf auth login
   ```

5. Exit WSL and return to this task with “已登录，继续”. Codex can then download
   and validate the checkpoint. This is no longer required for the current
   PairDETR + SAM 2.1 route.

The token must not be pasted into a repository file, script, screenshot, or chat
message. It is stored only in the isolated Linux user's Hugging Face credential
store.

## Required for model comparison

- Provide 20 representative original group photos that may be used locally for
  testing. The current UI screenshot is useful for execution testing but not
  for measuring accuracy.
- Confirm the expected whole-person crop for ambiguous or occluded people.
- Later, label hard examples if a fine-tuned detector becomes necessary.
