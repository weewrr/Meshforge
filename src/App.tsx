import { Sidebar, TitleBar } from './components/Chrome'
import GeneratePage from './pages/GeneratePage'
import ModelsPage from './pages/ModelsPage'
import SettingsPage from './pages/SettingsPage'
import WorkflowsPage from './pages/WorkflowsPage'
import { useNavigationStore } from './stores/navigation'

export default function App() {
  const page = useNavigationStore((s) => s.page)

  return (
    <div className="app">
      <TitleBar />
      <div className="app__body">
        <Sidebar />
        <div className="app__content">
          {page === 'workflows' && <WorkflowsPage />}
          {page === 'generate' && <GeneratePage />}
          {page === 'models' && <ModelsPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </div>
    </div>
  )
}
