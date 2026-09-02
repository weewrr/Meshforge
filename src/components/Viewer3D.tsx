import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Center, OrbitControls, TransformControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { Group, Mesh } from 'three'
import { useSceneStore, type LightSettings, type ViewMode } from '../stores/scene'

// ─── Matcap / UV checker textures (generated once) ─────────────────────────

function makeMatcapTexture(): THREE.Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size * 0.35, size * 0.35, size * 0.05, size * 0.5, size * 0.5, size * 0.5)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.4, '#b9c2d4')
  grad.addColorStop(0.75, '#4a5064')
  grad.addColorStop(1, '#181b22')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeUvCheckerTexture(): THREE.Texture {
  const size = 512
  const cells = 8
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const colors = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffb703', '#8ecae6', '#219ebc']
  const cell = size / cells
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = colors[(x + y) % colors.length]
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 2
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, size); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(size, i * cell); ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

let matcapTex: THREE.Texture | null = null
let uvTex: THREE.Texture | null = null

function getMatcap(): THREE.Texture {
  if (!matcapTex) matcapTex = makeMatcapTexture()
  return matcapTex
}

function getUvChecker(): THREE.Texture {
  if (!uvTex) uvTex = makeUvCheckerTexture()
  return uvTex
}

// ─── View-mode material swapping ────────────────────────────────────────────

function applyViewMode(root: THREE.Object3D, mode: ViewMode): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    const data = mesh.userData as {
      _origMat?: THREE.Material | THREE.Material[]
      _modeMat?: ViewMode
    }
    if (!data._origMat) data._origMat = mesh.material as THREE.Material | THREE.Material[]

    if (mode === 'solid') {
      mesh.material = data._origMat
      return
    }
    if (mode === 'wireframe') {
      const orig = data._origMat
      const toWire = (m: THREE.Material): THREE.Material => {
        const c = m.clone() as THREE.MeshStandardMaterial
        c.wireframe = true
        return c
      }
      mesh.material = Array.isArray(orig)
        ? orig.map(toWire)
        : toWire(orig)
      return
    }
    // Shared single-material modes replace materials wholesale.
    if (data._modeMat !== mode) {
      if (mode === 'normals') mesh.material = new THREE.MeshNormalMaterial()
      else if (mode === 'matcap') mesh.material = new THREE.MeshMatcapMaterial({ matcap: getMatcap() })
      else if (mode === 'uv') mesh.material = new THREE.MeshStandardMaterial({ map: getUvChecker(), roughness: 0.8, metalness: 0 })
      data._modeMat = mode
    }
  })
}

// ─── Model ─────────────────────────────────────────────────────────────────

interface ModelProps {
  url: string
  viewMode: ViewMode
  selected: boolean
  gizmoMode: 'translate' | 'rotate' | 'scale' | null
  onSelect: (selected: boolean) => void
  onStats: (stats: { triangles: number; vertices: number } | null) => void
}

function Model({ url, viewMode, selected, gizmoMode, onSelect, onStats }: ModelProps) {
  const { scene } = useGLTF(url)
  const cloned = useMemo<Group>(() => scene.clone(true), [scene])

  useEffect(() => {
    applyViewMode(cloned, viewMode)
  }, [cloned, viewMode])

  useEffect(() => {
    let triangles = 0
    let vertices = 0
    cloned.traverse((obj) => {
      const mesh = obj as Mesh
      if (mesh.isMesh && mesh.geometry) {
        const g = mesh.geometry
        if (g.index) triangles += g.index.count / 3
        else if (g.attributes.position) triangles += g.attributes.position.count / 3
        if (g.attributes.position) vertices += g.attributes.position.count
      }
    })
    onStats({ triangles: Math.round(triangles), vertices })
    return () => onStats(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stats computed once per loaded model
  }, [cloned])

  // Emissive highlight while selected.
  useEffect(() => {
    cloned.traverse((obj) => {
      const mesh = obj as Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      mats.forEach((m) => {
        const std = m as THREE.MeshStandardMaterial
        if (!std || !('emissive' in std)) return
        if (selected && !mesh.userData._emissiveSet) {
          mesh.userData._origEmissive = std.emissive.getHex()
          std.emissive.setHex(0x2b3a55)
          mesh.userData._emissiveSet = true
        } else if (!selected && mesh.userData._emissiveSet) {
          std.emissive.setHex(mesh.userData._origEmissive ?? 0x000000)
          mesh.userData._emissiveSet = false
        }
      })
    })
  }, [cloned, selected])

  return (
    <>
      <primitive
        object={cloned}
        onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); onSelect(true) }}
      />
      {selected && gizmoMode && <TransformControls object={cloned} mode={gizmoMode} size={0.8} />}
    </>
  )
}

// ─── Screenshot bridge ──────────────────────────────────────────────────────

function ScreenshotBridge({ captureRef }: {
  captureRef: React.MutableRefObject<(() => string) | null>
}) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    captureRef.current = () => {
      gl.render(scene, camera)
      return gl.domElement.toDataURL('image/png')
    }
    return () => { captureRef.current = null }
  }, [gl, scene, camera, captureRef])
  return null
}

// ─── Main viewer ───────────────────────────────────────────────────────────

export default function Viewer3D({
  url,
  light
}: {
  url: string
  light?: LightSettings
}) {
  const l = light ?? { ambient: 0.7, main: 1.4, fill: 0.4 }
  const viewMode = useSceneStore((s) => s.viewMode)
  const autoRotate = useSceneStore((s) => s.autoRotate)
  const gizmoMode = useSceneStore((s) => s.gizmoMode)
  const meshSelected = useSceneStore((s) => s.meshSelected)
  const setMeshSelected = useSceneStore((s) => s.setMeshSelected)
  const setMeshStats = useSceneStore((s) => s.setMeshStats)
  const captureRef = useRef<(() => string) | null>(null)

  // Re-render before capturing so the buffer holds a fresh frame.
  function screenshot(): string | null {
    return captureRef.current?.() ?? null
  }

  return (
    <div className="gp-viewer__canvas">
      <Canvas
        camera={{ position: [2.2, 1.6, 2.2], fov: 45 }}
        gl={{ preserveDrawingBuffer: true }}
        onPointerMissed={() => setMeshSelected(false)}
      >
        <color attach="background" args={['#161920']} />
        <ambientLight intensity={l.ambient} />
        <directionalLight position={[3, 4, 2]} intensity={l.main} />
        <directionalLight position={[-3, -1, -2]} intensity={l.fill} />
        <Suspense fallback={null}>
          <Center>
            <Model
              url={url}
              viewMode={viewMode}
              selected={meshSelected}
              gizmoMode={gizmoMode}
              onSelect={setMeshSelected}
              onStats={setMeshStats}
            />
          </Center>
        </Suspense>
        <OrbitControls makeDefault enableDamping autoRotate={autoRotate} autoRotateSpeed={1.5} />
        <ScreenshotBridge captureRef={captureRef} />
      </Canvas>
      <ViewerToolbar onScreenshot={screenshot} />
    </div>
  )
}

// ─── Floating view-mode toolbar ─────────────────────────────────────────────

const VIEW_MODES: { mode: ViewMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: 'solid',
    label: 'Solid',
    icon: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    )
  },
  {
    mode: 'wireframe',
    label: 'Wireframe',
    icon: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    )
  },
  {
    mode: 'normals',
    label: 'Normals',
    icon: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <line x1="3" y1="12" x2="21" y2="12" />
      </svg>
    )
  },
  {
    mode: 'matcap',
    label: 'Matcap',
    icon: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 10 Q10 7 12 10 Q14 13 16 10" />
      </svg>
    )
  },
  {
    mode: 'uv',
    label: 'UV Checker',
    icon: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <rect x="3" y="3" width="9" height="9" fill="currentColor" fillOpacity="0.3" />
        <rect x="12" y="12" width="9" height="9" fill="currentColor" fillOpacity="0.3" />
      </svg>
    )
  }
]

function ViewerToolbar({ onScreenshot }: { onScreenshot: () => string | null }) {
  const viewMode = useSceneStore((s) => s.viewMode)
  const setViewMode = useSceneStore((s) => s.setViewMode)
  const autoRotate = useSceneStore((s) => s.autoRotate)
  const toggleAutoRotate = useSceneStore((s) => s.toggleAutoRotate)

  function handleScreenshot(): void {
    const data = onScreenshot()
    if (!data) return
    const a = document.createElement('a')
    a.href = data
    a.download = `meshforge-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="gp-vt">
      {VIEW_MODES.map(({ mode, label, icon }) => (
        <button
          key={mode}
          title={label}
          aria-label={label}
          className={`gp-vt__btn ${viewMode === mode ? 'gp-vt__btn--active' : ''}`}
          onClick={() => setViewMode(mode)}
        >
          {icon}
        </button>
      ))}
      <div className="gp-vt__sep" />
      <button
        title="Auto-rotate"
        aria-label="Auto-rotate"
        className={`gp-vt__btn ${autoRotate ? 'gp-vt__btn--active' : ''}`}
        onClick={toggleAutoRotate}
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>
      <button title="Screenshot" aria-label="Screenshot" className="gp-vt__btn" onClick={handleScreenshot}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </button>
    </div>
  )
}
