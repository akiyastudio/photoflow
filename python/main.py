import sys
import json
import os
import multiprocessing as mp

def main():
    mp.freeze_support()

    if sys.platform.startswith('win'):
        try:
            if sys.stdout is not None:
                sys.stdout.reconfigure(encoding='utf-8')
            if sys.stderr is not None:
                sys.stderr.reconfigure(encoding='utf-8')
        except Exception:
            pass
        
    if len(sys.argv) < 2:
        print(json.dumps({"type": "error", "message": "No command provided"}))
        return

    command = sys.argv[1] 
    args = sys.argv[2:]

    try:
        if command == 'classify.py':
            import classify
            classify.run(args)
            
        elif command == 'png_to_jpg.py':
            import png_to_jpg
            png_to_jpg.run(args)
            
        elif command == 'research.py':
            import research
            research.run(args)
            
        elif command == 'catch.py':
            import catch
            catch.run(args)
            
        elif command == 'rename.py':
            import rename
            rename.run(args)
            
        else:
            print(json.dumps({"type": "error", "message": f"Unknown command: {command}"}))

        # 【修改点 3】强制刷新缓冲区，确保 Electron 立即收到数据
        sys.stdout.flush()

    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}))
        sys.stdout.flush()

if __name__ == "__main__":
    main()