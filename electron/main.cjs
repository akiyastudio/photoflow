const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;

function createWindow() {
  // 2. 彻底移除顶部菜单栏 (File, Edit, View...)
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#020617',
    titleBarStyle: 'hidden', 
    titleBarOverlay: {
      color: '#020617',
      symbolColor: '#ffffff',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    //mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// 获取 Python 路径
const getPythonPath = () => {
  if (app.isPackaged) {
    // 【生产环境】直接找打包好的 exe
    return path.join(process.resourcesPath, 'python', 'main.exe');
  } else {
    // 【开发环境】找 python 解释器 (优先 .venv)
    const rootDir = path.join(__dirname, '..');
    const isWin = process.platform === 'win32';
    const venvPython = isWin
      ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
      : path.join(rootDir, '.venv', 'bin', 'python');
      
    if (fs.existsSync(venvPython)) return venvPython;
    return 'python'; // 回退到系统 python
  }
};

// 获取脚本入口 (仅开发环境需要)
const getScriptEntry = () => {
  return path.join(__dirname, '../python/main.py');
};

// 运行 Python 脚本
ipcMain.on('run-python', (event, scriptName, args = []) => {
  const pythonExec = getPythonPath();
  let spawnArgs = [];

  if (app.isPackaged) {
    spawnArgs = [scriptName, ...args];
  } else {
    spawnArgs = ['-u', getScriptEntry(), scriptName, ...args];
  }

  console.log(`Executing: ${pythonExec} ${spawnArgs.join(' ')}`);

  const pyProcess = spawn(pythonExec, spawnArgs);
  
  // 监听标准输出 (Logs, JSON data)
  pyProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        // 尝试解析 JSON
        const jsonMsg = JSON.parse(trimmed);
        mainWindow.webContents.send('python-event', jsonMsg);
        
        // 兼容旧的日志显示逻辑
        if (jsonMsg.type === 'log' || jsonMsg.type === 'error') {
           mainWindow.webContents.send('python-log', {
              timestamp: new Date().toLocaleTimeString(),
              message: jsonMsg.message,
              type: jsonMsg.type === 'error' ? 'error' : 'info'
           });
        }
      } catch (e) {
        // 解析失败，当作普通文本日志
        console.log("Raw Python Output:", trimmed);
        mainWindow.webContents.send('python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: trimmed,
            type: 'info'
        });
      }
    });
  });

  // 监听错误输出 (Stderr)
  pyProcess.stderr.on('data', (data) => {
    const message = data.toString().trim();
    if (message) {
      console.error("Python Stderr:", message);
      mainWindow.webContents.send('python-log', {
          timestamp: new Date().toLocaleTimeString(),
          message: message,
          type: 'error'
      });
    }
  });

  // 监听进程结束
  pyProcess.on('close', (code) => {
    mainWindow.webContents.send('python-log', {
        timestamp: new Date().toLocaleTimeString(),
        message: `Process finished with exit code ${code}`,
        type: code === 0 ? 'success' : 'warning'
    });
  });
});

const getConfigDir = () => {
  // 在用户数据目录下创建 config 文件夹
  const userDataPath = app.getPath('userData');
  const configDir = path.join(userDataPath, 'photo-flow');
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  return configDir;
};

const getConfigPath = () => {
  return path.join(getConfigDir(), 'photoflow_config.json');
};

ipcMain.handle('getUserPath', async (event) => {
  try {
    const userPath = app.getPath('home').replace(/\\/g, '/');
    console.log('✅ User Path detected (Node.js):', userPath);
    return userPath;

  } catch (error) {
    console.error('❌ Error getting user path:', error);
    return "";
  }
});

ipcMain.handle('saveConfig', async (event, config) => {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('✅ Config saved to:', configPath);
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to save config:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('loadConfig', async (event) => {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      console.log('✅ Config loaded from:', configPath);
      return JSON.parse(data);
    }
    console.log('⚠️ No config file found, will use defaults');
    return null;
  } catch (error) {
    console.error('❌ Failed to load config:', error);
    return null;
  }
});

// 生日数据管理

const getUserBirthdaysPath = () => {
  return path.join(getConfigDir(), 'birthdays.json');
};

const getResourceBirthdaysPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', 'birthdays.json');
  }
  return path.join(__dirname, '../python/birthdays.json');
};

ipcMain.handle('get-birthdays', async () => {
  try {
    const userPath = getUserBirthdaysPath();
    
    // 如果用户目录没有该文件，尝试从资源目录复制一份
    if (!fs.existsSync(userPath)) {
      const resourcePath = getResourceBirthdaysPath();
      if (fs.existsSync(resourcePath)) {
        console.log('Initialize birthdays.json from resources...');
        fs.copyFileSync(resourcePath, userPath);
      } else {
        // 如果资源目录也没有，就创建一个空的
        return {}; 
      }
    }

    // 读取用户目录下的文件
    const data = fs.readFileSync(userPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading birthdays.json:', error);
    return {};
  }
});

ipcMain.handle('save-birthdays', async (event, newContent) => {
  try {
    // 始终写入用户目录，确保有权限
    const userPath = getUserBirthdaysPath();
    fs.writeFileSync(userPath, JSON.stringify(newContent, null, 4), 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Error writing birthdays.json:', error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});