import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AppDialogProvider } from './components/AppDialogProvider.tsx'
import { LayerProvider } from './components/LayerProvider.tsx'
import { TaskCenterProvider } from './features/background-tasks/TaskCenter.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LayerProvider>
      <AppDialogProvider>
        <TaskCenterProvider>
          <App />
        </TaskCenterProvider>
      </AppDialogProvider>
    </LayerProvider>
  </React.StrictMode>,
)
