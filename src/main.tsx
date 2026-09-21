import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import ReactDOM from 'react-dom/client'

import { App } from './App'
import './styles/globals.css'
import './styles/tracker.css'

const rootRoute = createRootRoute()
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: App,
})
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element is missing')
ReactDOM.createRoot(root).render(<RouterProvider router={router} />)
