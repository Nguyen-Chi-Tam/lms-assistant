'use client';

import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpDown,
  RefreshCw,
  FoldHorizontal,
  UnfoldHorizontal,
  Maximize2,
  Minimize2,
  Image as ImageIcon,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Link2,
  Check,
  Save,
  Loader2,
} from 'lucide-react';
import { exportElementToPng } from '@/lib/export-utils';

export interface MindmapNodeItem {
  id?: string;
  title: string;
  children?: MindmapNodeItem[];
  items?: (string | MindmapNodeItem)[];
  notes?: string;
  [key: string]: any;
}

export interface CustomLink {
  id: string;
  fromId: string;
  toId: string;
  label?: string;
}

export interface MindmapData {
  root: string;
  branches: MindmapNodeItem[];
  customLinks?: CustomLink[];
  orientation?: 'horizontal' | 'vertical';
}

interface InteractiveMindmapProps {
  root: string;
  branches: MindmapNodeItem[];
  customLinks?: CustomLink[];
  originalData?: MindmapData | { root?: string; branches?: MindmapNodeItem[]; customLinks?: CustomLink[] };
  courseTitle: string;
  levelLabel?: string;
  topic?: string;
  initialOrientation?: 'horizontal' | 'vertical';
  onOrientationChange?: (orientation: 'horizontal' | 'vertical') => void;
  onSaveData?: (data: MindmapData) => Promise<void> | void;
  onReconfigure?: () => void;
  notify: (msg: string) => void;
}

interface Position {
  x: number;
  y: number;
}

interface NormalizedNode {
  id: string;
  label: string;
  depth: number;
  colorIndex: number;
  parentId?: string;
  children: NormalizedNode[];
  width: number;
  height: number;
  subtreeSpan: number;
  x: number;
  y: number;
}

interface LayoutNode {
  id: string;
  label: string;
  depth: number;
  parentId?: string;
  colorIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  hasChildren: boolean;
  isExpanded: boolean;
  childIds: string[];
}

interface LayoutConnection {
  id: string;
  fromId: string;
  toId: string;
  from: Position;
  to: Position;
  isCustom?: boolean;
}

export const BRANCH_PALETTES = [
  { id: 0, main: '#818cf8', glow: 'rgba(129, 140, 248, 0.55)', light: '#a5b4fc' }, // Indigo
  { id: 1, main: '#38bdf8', glow: 'rgba(56, 189, 248, 0.55)', light: '#7dd3fc' },   // Sky Blue
  { id: 2, main: '#34d399', glow: 'rgba(52, 211, 153, 0.55)', light: '#6ee7b7' },   // Emerald
  { id: 3, main: '#fbbf24', glow: 'rgba(251, 191, 36, 0.55)', light: '#fde68a' },   // Amber
  { id: 4, main: '#f472b6', glow: 'rgba(244, 114, 182, 0.55)', light: '#fbcfe8' }, // Pink
];

// Helpers for dynamic height calculation without truncation
function estimateNodeHeight(text: string, charsPerLine: number, basePadding: number, lineHeight: number) {
  const lineCount = Math.max(1, Math.ceil((text || '').length / charsPerLine));
  return basePadding + lineCount * lineHeight;
}

// Recursively collect all descendant node IDs
function getDescendantNodeIds(nodeId: string, allNodes: LayoutNode[]): string[] {
  const result: string[] = [];
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const node of allNodes) {
      if (node.parentId === parent) {
        result.push(node.id);
        queue.push(node.id);
      }
    }
  }
  return result;
}

// Helper to convert arbitrary raw branch/node item into NormalizedNode tree
function normalizeNodeTree(
  rawItem: any,
  depth: number,
  colorIndex: number,
  parentId?: string,
  prefix: string = 'node'
): NormalizedNode {
  const label =
    typeof rawItem === 'string'
      ? rawItem
      : rawItem?.title || rawItem?.label || rawItem?.name || `Mục ${prefix}`;
  const id = rawItem?.id || `${prefix}`;

  const rawChildrenList = Array.isArray(rawItem?.children)
    ? rawItem.children
    : Array.isArray(rawItem?.items)
    ? rawItem.items
    : [];

  const children: NormalizedNode[] = rawChildrenList.map((c: any, idx: number) =>
    normalizeNodeTree(c, depth + 1, colorIndex, id, `${id}-${idx}`)
  );

  let width = 280;
  let height = 48;
  if (depth === 0) {
    width = 280;
    height = estimateNodeHeight(label, 26, 36, 20);
  } else if (depth === 1) {
    width = 280;
    height = estimateNodeHeight(label, 25, 28, 18);
  } else {
    width = 280;
    height = estimateNodeHeight(label, 27, 24, 18);
  }

  return {
    id,
    label,
    depth,
    colorIndex,
    parentId,
    children,
    width,
    height,
    subtreeSpan: 0,
    x: 0,
    y: 0,
  };
}

export function InteractiveMindmap({
  root,
  branches = [],
  customLinks: initialCustomLinks = [],
  originalData,
  courseTitle,
  levelLabel,
  topic,
  initialOrientation = 'horizontal',
  onOrientationChange,
  onSaveData,
  onReconfigure,
  notify,
}: InteractiveMindmapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Local state for mindmap data
  const [rootText, setRootText] = useState<string>(() => root || courseTitle || 'Chủ đề chính');
  const [branchesState, setBranchesState] = useState<MindmapNodeItem[]>(branches);
  const [customLinksState, setCustomLinksState] = useState<CustomLink[]>(initialCustomLinks);

  // Hover state: ONLY this node shows the floating action toolbar
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Layout Orientation: 'horizontal' or 'vertical'
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>(initialOrientation);

  useEffect(() => {
    if (initialOrientation) {
      setOrientation(initialOrientation);
    }
  }, [initialOrientation]);

  // Expanded nodes map: default to expanded for all
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});

  // Canvas Pan & Zoom
  const [pan, setPan] = useState<Position>({ x: 50, y: 50 });
  const [zoom, setZoom] = useState<number>(1);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<Position>({ x: 0, y: 0 });

  // Custom dragged node offsets
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, Position>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    id: string;
    startMouse: Position;
    descendantIds: string[];
    initialOffsets: Record<string, Position>;
  } | null>(null);

  // Node editing state
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>('');

  // Snapshot of what is saved in the database (deep cloned)
  const lastSavedSnapshotRef = useRef<{
    root: string;
    branches: MindmapNodeItem[];
    customLinks: CustomLink[];
    orientation?: 'horizontal' | 'vertical';
  }>({
    root: root || courseTitle || 'Chủ đề chính',
    branches: JSON.parse(JSON.stringify(branches || [])),
    customLinks: JSON.parse(JSON.stringify(initialCustomLinks || [])),
    orientation: initialOrientation,
  });

  // Refs to prevent state collision / save conflicts between parent and child
  const hasLocalModificationsRef = useRef(false);
  const editingNodeIdRef = useRef<string | null>(null);
  editingNodeIdRef.current = editingNodeId;

  // Sync when outside props change (ONLY when user has not made local edits, and not actively editing!)
  useEffect(() => {
    if (hasLocalModificationsRef.current) {
      // User has made local modifications in this session; never overwrite with parent props
      return;
    }
    if (editingNodeIdRef.current) {
      // Don't overwrite while user is actively typing in a node!
      return;
    }
    const nextRoot = root || courseTitle || 'Chủ đề chính';
    setRootText(nextRoot);
    setBranchesState(branches);
    lastSavedSnapshotRef.current = {
      root: nextRoot,
      branches: JSON.parse(JSON.stringify(branches || [])),
      customLinks: JSON.parse(JSON.stringify(initialCustomLinks || [])),
      orientation: initialOrientation,
    };
  }, [root, courseTitle, branches, initialCustomLinks, initialOrientation]);

  useEffect(() => {
    if (hasLocalModificationsRef.current) {
      return;
    }
    if (initialCustomLinks) {
      setCustomLinksState(initialCustomLinks);
    }
  }, [initialCustomLinks]);

  // Node manual linking state
  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);

  const [isExporting, setIsExporting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Focus textarea when editing starts
  useEffect(() => {
    if (editingNodeId && editTextareaRef.current) {
      editTextareaRef.current.focus();
      editTextareaRef.current.select();
    }
  }, [editingNodeId]);

  // Sync native fullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      const activeElement = document.fullscreenElement || (document as any).webkitFullscreenElement;
      const isNowFullscreen = activeElement === wrapperRef.current;
      setIsFullscreen(isNowFullscreen);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Handle ESC key to cancel linking / editing / fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingNodeId) {
          setEditingNodeId(null);
          notify('Đã hủy chỉnh sửa nút');
        } else if (linkingSourceId) {
          setLinkingSourceId(null);
          notify('Đã hủy chế độ nối liên kết');
        } else if (isFullscreen && !document.fullscreenElement) {
          setIsFullscreen(false);
          notify('Đã thoát chế độ toàn màn hình');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingNodeId, linkingSourceId, isFullscreen, notify]);

  // Save status states
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'unsaved'>('idle');
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(null);

  // Reset saved status to idle after 4 seconds
  useEffect(() => {
    if (saveStatus === 'saved') {
      const timer = setTimeout(() => {
        setSaveStatus('idle');
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  // Mark local changes as unsaved (NO auto-save to database)
  const markUnsaved = useCallback(() => {
    hasLocalModificationsRef.current = true;
    setSaveStatus('unsaved');
  }, []);

  // Explicit Manual Save handler to Database
  const handleManualSave = async () => {
    hasLocalModificationsRef.current = true;
    if (!onSaveData) {
      notify('Đã lưu dữ liệu sơ đồ tư duy cục bộ');
      setSaveStatus('saved');
      lastSavedSnapshotRef.current = {
        root: rootText,
        branches: JSON.parse(JSON.stringify(branchesState)),
        customLinks: JSON.parse(JSON.stringify(customLinksState)),
        orientation,
      };
      hasLocalModificationsRef.current = false;
      return;
    }

    try {
      setSaveStatus('saving');
      const dataToSave: MindmapData = {
        root: rootText,
        branches: branchesState,
        customLinks: customLinksState,
        orientation,
      };
      await onSaveData(dataToSave);
      setSaveStatus('saved');
      setLastSavedTime(new Date());
      lastSavedSnapshotRef.current = {
        root: rootText,
        branches: JSON.parse(JSON.stringify(branchesState)),
        customLinks: JSON.parse(JSON.stringify(customLinksState)),
        orientation,
      };
      hasLocalModificationsRef.current = false;
      notify('✓ Đã lưu toàn bộ thay đổi sơ đồ vào CSDL thành công!');
    } catch {
      setSaveStatus('unsaved');
      notify('Lỗi khi lưu vào CSDL. Vui lòng kiểm tra kết nối mạng và thử lại.');
    }
  };

  // Toggle single node expand/collapse
  const toggleNodeExpand = (nodeId: string) => {
    setExpandedNodes(prev => ({
      ...prev,
      [nodeId]: prev[nodeId] === false ? true : false,
    }));
  };

  /* ──────────────────────────────────────────────────────────
     UNIVERSAL TREE LAYOUT ENGINE (N-GENERATIONS)
     ────────────────────────────────────────────────────────── */
  const { nodes, connections, canvasWidth, canvasHeight, rootTree } = useMemo(() => {
    const rootLabel = rootText || 'Chủ đề chính';

    // 1. Build Normalized Root Tree
    const rootNode: NormalizedNode = {
      id: 'root',
      label: rootLabel,
      depth: 0,
      colorIndex: 0,
      children: branchesState.map((b, idx) =>
        normalizeNodeTree(b, 1, idx % 5, 'root', `branch-${idx}`)
      ),
      width: 280,
      height: estimateNodeHeight(rootLabel, 26, 36, 20),
      subtreeSpan: 0,
      x: 0,
      y: 0,
    };

    const computedNodes: LayoutNode[] = [];
    const computedConns: LayoutConnection[] = [];

    if (orientation === 'horizontal') {
      /* ── A. HORIZONTAL LAYOUT (Left-to-Right / NotebookLM) ──────
         Root on the left. Level 1 branches in column 2 (stacked vertically).
         Level 2 children in column 3 (stacked vertically under each branch).
         Level 3+ in subsequent columns (stacked vertically).
         ────────────────────────────────────────────────────────── */
      const colGap = 72;
      const rowGap = 16;
      const startX = 60;

      function measureHeight(node: NormalizedNode): number {
        const isExp = expandedNodes[node.id] !== false;
        if (!isExp || node.children.length === 0) {
          node.subtreeSpan = node.height;
          return node.subtreeSpan;
        }
        let total = 0;
        for (let i = 0; i < node.children.length; i++) {
          const cHeight = measureHeight(node.children[i]);
          total += cHeight;
          if (i > 0) total += rowGap;
        }
        node.subtreeSpan = Math.max(node.height, total);
        return node.subtreeSpan;
      }

      measureHeight(rootNode);

      function layoutHorizontal(
        node: NormalizedNode,
        currentX: number,
        currentY: number
      ) {
        node.x = currentX;
        const isExp = expandedNodes[node.id] !== false;
        const visibleChildren = isExp ? node.children : [];

        if (visibleChildren.length === 0) {
          node.y = currentY + (node.subtreeSpan - node.height) / 2;
        } else {
          let childY = currentY;
          const nextX = currentX + node.width + colGap;

          visibleChildren.forEach(child => {
            layoutHorizontal(child, nextX, childY);
            childY += child.subtreeSpan + rowGap;
          });

          // Center parent vertically with respect to its children
          const firstChild = visibleChildren[0];
          const lastChild = visibleChildren[visibleChildren.length - 1];
          const firstCenter = firstChild.y + firstChild.height / 2;
          const lastCenter = lastChild.y + lastChild.height / 2;
          node.y = (firstCenter + lastCenter) / 2 - node.height / 2;

          // Connections from Parent right to Child left
          visibleChildren.forEach(child => {
            computedConns.push({
              id: `conn-${node.id}-${child.id}`,
              fromId: node.id,
              toId: child.id,
              from: { x: node.x + node.width, y: node.y + node.height / 2 },
              to: { x: child.x, y: child.y + child.height / 2 },
            });
          });
        }

        computedNodes.push({
          id: node.id,
          label: node.label,
          depth: node.depth,
          parentId: node.parentId,
          colorIndex: node.colorIndex,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          hasChildren: node.children.length > 0,
          isExpanded: isExp,
          childIds: node.children.map(c => c.id),
        });
      }

      layoutHorizontal(rootNode, startX, 40);

      let maxX = 850;
      let maxY = 600;
      computedNodes.forEach(n => {
        if (n.x + n.width + 100 > maxX) maxX = n.x + n.width + 100;
        if (n.y + n.height + 80 > maxY) maxY = n.y + n.height + 80;
      });

      return {
        nodes: computedNodes,
        connections: computedConns,
        canvasWidth: maxX,
        canvasHeight: maxY,
        rootTree: rootNode,
      };
    } else {
      /* ── B. VERTICAL / COLUMN LAYOUT (Top-to-Bottom columns) ────
         Root is on top center.
         Branches are in a row from left to right.
         Under each branch, its children are STACKED VERTICALLY in a column!
         ────────────────────────────────────────────────────────── */
      const startX = 60;
      const startY = 40;
      const colWidth = 280;
      const colGap = 36;
      const cardGap = 16;

      const numBranches = Math.max(1, rootNode.children.length);
      const totalColumnsWidth = numBranches * colWidth + (numBranches - 1) * colGap;

      const rootWidth = Math.max(280, Math.min(380, estimateNodeHeight(rootLabel, 26, 36, 20) * 3));
      const rootHeight = estimateNodeHeight(rootLabel, 28, 36, 20);
      const rootX = startX + totalColumnsWidth / 2 - rootWidth / 2;
      const rootY = startY;

      // 1. Root Node at top center
      computedNodes.push({
        id: rootNode.id,
        label: rootNode.label,
        depth: 0,
        colorIndex: 0,
        x: rootX,
        y: rootY,
        width: rootWidth,
        height: rootHeight,
        hasChildren: rootNode.children.length > 0,
        isExpanded: true,
        childIds: rootNode.children.map(c => c.id),
      });

      let maxColumnY = rootY + rootHeight + 100;

      // 2. Each Branch is a column, laid out horizontally across the top row
      rootNode.children.forEach((branch, bIdx) => {
        const colX = startX + bIdx * (colWidth + colGap);
        const branchY = rootY + rootHeight + 70;
        const branchHeight = estimateNodeHeight(branch.label, 26, 28, 18);
        const isBranchExp = expandedNodes[branch.id] !== false;

        // Connection from Root (Bottom center) -> Branch (Top center)
        computedConns.push({
          id: `conn-root-${branch.id}`,
          fromId: rootNode.id,
          toId: branch.id,
          from: { x: rootX + rootWidth / 2, y: rootY + rootHeight },
          to: { x: colX + colWidth / 2, y: branchY },
        });

        computedNodes.push({
          id: branch.id,
          label: branch.label,
          depth: 1,
          parentId: rootNode.id,
          colorIndex: branch.colorIndex,
          x: colX,
          y: branchY,
          width: colWidth,
          height: branchHeight,
          hasChildren: branch.children.length > 0,
          isExpanded: isBranchExp,
          childIds: branch.children.map(c => c.id),
        });

        // 3. Children STACKED VERTICALLY in this column
        let currentCardY = branchY + branchHeight + 24;
        let prevNodeId = branch.id;
        let prevBottomPos = { x: colX + colWidth / 2, y: branchY + branchHeight };

        if (isBranchExp && branch.children.length > 0) {
          const layoutVerticalChildren = (childList: NormalizedNode[], depth: number) => {
            childList.forEach(child => {
              const isChildExp = expandedNodes[child.id] !== false;
              const indent = Math.min(32, (depth - 2) * 14);
              const cardWidth = colWidth - indent;
              const cardX = colX + indent;
              const cardHeight = estimateNodeHeight(child.label, 27, 24, 18);
              const cardY = currentCardY;

              // Connection from preceding node bottom to this child top
              computedConns.push({
                id: `conn-${prevNodeId}-${child.id}`,
                fromId: prevNodeId,
                toId: child.id,
                from: prevBottomPos,
                to: { x: cardX + cardWidth / 2, y: cardY },
              });

              computedNodes.push({
                id: child.id,
                label: child.label,
                depth: child.depth,
                parentId: child.parentId,
                colorIndex: child.colorIndex,
                x: cardX,
                y: cardY,
                width: cardWidth,
                height: cardHeight,
                hasChildren: child.children.length > 0,
                isExpanded: isChildExp,
                childIds: child.children.map(c => c.id),
              });

              currentCardY += cardHeight + cardGap;
              prevNodeId = child.id;
              prevBottomPos = { x: cardX + cardWidth / 2, y: cardY + cardHeight };

              if (isChildExp && child.children.length > 0) {
                layoutVerticalChildren(child.children, depth + 1);
              }
            });
          };

          layoutVerticalChildren(branch.children, 2);
        }

        if (currentCardY > maxColumnY) {
          maxColumnY = currentCardY;
        }
      });

      const maxX = Math.max(1050, startX + totalColumnsWidth + 100);
      const maxY = Math.max(650, maxColumnY + 80);

      return {
        nodes: computedNodes,
        connections: computedConns,
        canvasWidth: maxX,
        canvasHeight: maxY,
        rootTree: rootNode,
      };
    }
  }, [rootText, branchesState, expandedNodes, orientation]);

  // Check if any node with children is currently collapsed
  const isAnyNodeCollapsed = useMemo(() => {
    return Object.values(expandedNodes).some(v => v === false);
  }, [expandedNodes]);

  // Toggle all expand/collapse
  const toggleExpandAll = useCallback(() => {
    if (!isAnyNodeCollapsed) {
      // All nodes currently expanded -> collapse all nodes that have children
      const next: Record<string, boolean> = {};
      nodes.forEach(n => {
        if (n.hasChildren && n.id !== 'root') {
          next[n.id] = false;
        }
      });
      const markCollapsed = (bList: MindmapNodeItem[], pId: string) => {
        bList.forEach((b, idx) => {
          const id = b.id || `${pId}-${idx}`;
          const kids = b.children || (b.items as any[]) || [];
          if (kids.length > 0) {
            next[id] = false;
            markCollapsed(kids, id);
          }
        });
      };
      markCollapsed(branchesState, 'branch');
      setExpandedNodes(next);
      notify('Đã thu gọn toàn bộ các nhánh');
    } else {
      // Some or all nodes are collapsed -> expand all
      setExpandedNodes({});
      notify('Đã mở rộng toàn bộ các nhánh');
    }
  }, [isAnyNodeCollapsed, nodes, branchesState, notify]);

  // Fast node lookup map
  const nodeMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    nodes.forEach(n => map.set(n.id, n));
    return map;
  }, [nodes]);

  const nodesWithOutgoingConns = useMemo(
    () => new Set(connections.map(c => c.fromId)),
    [connections]
  );

  // Dynamic connection positions taking user dragging offsets into account
  const activeConnections = useMemo(() => {
    const list: Array<{
      id: string;
      from: Position;
      to: Position;
      isCustom?: boolean;
      colorIndex: number;
      isFromRoot: boolean;
    }> = connections.map(conn => {
      const fromNode = nodeMap.get(conn.fromId);
      const toNode = nodeMap.get(conn.toId);
      const fromOffset = (fromNode && nodeOffsets[fromNode.id]) || { x: 0, y: 0 };
      const toOffset = (toNode && nodeOffsets[toNode.id]) || { x: 0, y: 0 };
      const isFromRoot = fromNode?.id === 'root' || fromNode?.depth === 0;
      const colorIndex = (toNode?.colorIndex ?? fromNode?.colorIndex ?? 0) % BRANCH_PALETTES.length;

      if (!fromNode || !toNode) {
        return {
          id: conn.id,
          from: { x: conn.from.x + fromOffset.x, y: conn.from.y + fromOffset.y },
          to: { x: conn.to.x + toOffset.x, y: conn.to.y + toOffset.y },
          colorIndex,
          isFromRoot,
        };
      }

      if (orientation === 'horizontal') {
        return {
          id: conn.id,
          from: {
            x: fromNode.x + fromNode.width + fromOffset.x,
            y: fromNode.y + fromNode.height / 2 + fromOffset.y,
          },
          to: {
            x: toNode.x + toOffset.x,
            y: toNode.y + toNode.height / 2 + toOffset.y,
          },
          colorIndex,
          isFromRoot,
        };
      } else {
        return {
          id: conn.id,
          from: {
            x: fromNode.x + fromNode.width / 2 + fromOffset.x,
            y: fromNode.y + fromNode.height + fromOffset.y,
          },
          to: {
            x: toNode.x + toNode.width / 2 + toOffset.x,
            y: toNode.y + toOffset.y,
          },
          colorIndex,
          isFromRoot,
        };
      }
    });

    // Custom manual links between arbitrary nodes
    customLinksState.forEach(link => {
      const fromNode = nodeMap.get(link.fromId);
      const toNode = nodeMap.get(link.toId);
      if (!fromNode || !toNode) return;

      const fromOffset = nodeOffsets[fromNode.id] || { x: 0, y: 0 };
      const toOffset = nodeOffsets[toNode.id] || { x: 0, y: 0 };

      const fX = fromNode.x + fromOffset.x;
      const fY = fromNode.y + fromOffset.y;
      const tX = toNode.x + toOffset.x;
      const tY = toNode.y + toOffset.y;

      let fromPt: Position;
      let toPt: Position;

      if (orientation === 'horizontal') {
        if (tX >= fX) {
          fromPt = { x: fX + fromNode.width, y: fY + fromNode.height / 2 };
          toPt = { x: tX, y: tY + toNode.height / 2 };
        } else {
          fromPt = { x: fX, y: fY + fromNode.height / 2 };
          toPt = { x: tX + toNode.width, y: tY + toNode.height / 2 };
        }
      } else {
        if (tY >= fY) {
          fromPt = { x: fX + fromNode.width / 2, y: fY + fromNode.height };
          toPt = { x: tX + toNode.width / 2, y: tY };
        } else {
          fromPt = { x: fX + fromNode.width / 2, y: fY };
          toPt = { x: tX + toNode.width / 2, y: tY + toNode.height };
        }
      }

      list.push({
        id: `custom-link-${link.id}`,
        from: fromPt,
        to: toPt,
        isCustom: true,
        colorIndex: fromNode.colorIndex % BRANCH_PALETTES.length,
        isFromRoot: false,
      });
    });

    return list;
  }, [connections, nodeMap, nodeOffsets, customLinksState, orientation]);

  // Dynamic Canvas Bounds: Expands dynamically so dragged nodes and lines are NEVER clipped
  const dynamicCanvasBounds = useMemo(() => {
    let maxX = canvasWidth;
    let maxY = canvasHeight;

    nodes.forEach(n => {
      const offset = nodeOffsets[n.id] || { x: 0, y: 0 };
      const currentX = n.x + offset.x;
      const currentY = n.y + offset.y;
      if (currentX + n.width + 1000 > maxX) maxX = currentX + n.width + 1000;
      if (currentY + n.height + 1000 > maxY) maxY = currentY + n.height + 1000;
    });

    activeConnections.forEach(c => {
      if (c.from.x + 600 > maxX) maxX = c.from.x + 600;
      if (c.from.y + 600 > maxY) maxY = c.from.y + 600;
      if (c.to.x + 600 > maxX) maxX = c.to.x + 600;
      if (c.to.y + 600 > maxY) maxY = c.to.y + 600;
    });

    // Provide a vast canvas space (minimum 6000 x 5000) so dragging is completely unconstrained
    return {
      width: Math.max(maxX, 6000),
      height: Math.max(maxY, 5000),
    };
  }, [canvasWidth, canvasHeight, nodes, nodeOffsets, activeConnections]);

  // Curved Bezier Path Creator
  const createCurvedPath = useCallback(
    (from: Position, to: Position, isCustom?: boolean) => {
      if (orientation === 'horizontal' && !isCustom) {
        if (Math.abs(from.y - to.y) < 4) {
          return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
        }
        const dx = to.x - from.x;
        const cp1x = from.x + dx * 0.5;
        const cp1y = from.y;
        const cp2x = to.x - dx * 0.5;
        const cp2y = to.y;
        return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
      } else if (orientation === 'vertical' && !isCustom) {
        if (Math.abs(from.x - to.x) < 4) {
          return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
        }
        const dy = to.y - from.y;
        const cp1x = from.x;
        const cp1y = from.y + dy * 0.5;
        const cp2x = to.x;
        const cp2y = to.y - dy * 0.5;
        return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
      } else {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const cx1 = from.x + dx * 0.3;
        const cy1 = from.y;
        const cx2 = to.x - dx * 0.3;
        const cy2 = to.y;
        return `M ${from.x} ${from.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${to.x} ${to.y}`;
      }
    },
    [orientation]
  );

  /* ──────────────────────────────────────────────────────────
     USER ACTIONS: EDIT, ADD, LINK, DELETE
     ────────────────────────────────────────────────────────── */

  const handleStartEdit = (nodeId: string, currentLabel: string) => {
    setEditingNodeId(nodeId);
    setEditingText(currentLabel);
  };

  const handleSaveEdit = (nodeId: string) => {
    const trimmed = editingText.trim();
    if (!trimmed) {
      setEditingNodeId(null);
      return;
    }

    if (nodeId === 'root') {
      setRootText(trimmed);
      setEditingNodeId(null);
      markUnsaved();
      notify('Đã cập nhật tiêu đề nút gốc');
      return;
    }

    function updateRecursive(list: MindmapNodeItem[], targetId: string, prefix: string): MindmapNodeItem[] {
      return list.map((item, idx) => {
        const curId = item.id || `${prefix}-${idx}`;
        if (curId === targetId) {
          return { ...item, title: trimmed };
        }
        const children = item.children || (item.items as any[]) || [];
        if (children.length > 0) {
          return {
            ...item,
            children: updateRecursive(children, targetId, curId),
          };
        }
        return item;
      });
    }

    const updated = updateRecursive(branchesState, nodeId, 'branch');
    setBranchesState(updated);
    setEditingNodeId(null);
    markUnsaved();
    notify('Đã lưu nội dung nút');
  };

  const handleAddChild = (parentNodeId: string) => {
    const newId = `node-${Date.now()}`;
    const newNode: MindmapNodeItem = {
      id: newId,
      title: 'Ý mới',
      children: [],
    };

    if (parentNodeId === 'root') {
      const updated = [...branchesState, newNode];
      setBranchesState(updated);
      setEditingNodeId(newId);
      setEditingText('Ý mới');
      markUnsaved();
      notify('Đã thêm nhánh mới vào nút gốc');
      return;
    }

    function addChildRecursive(list: MindmapNodeItem[], targetId: string, prefix: string): MindmapNodeItem[] {
      return list.map((item, idx) => {
        const curId = item.id || `${prefix}-${idx}`;
        if (curId === targetId) {
          const existingKids = item.children || (item.items as any[]) || [];
          return {
            ...item,
            children: [...existingKids, newNode],
          };
        }
        const children = item.children || (item.items as any[]) || [];
        if (children.length > 0) {
          return {
            ...item,
            children: addChildRecursive(children, targetId, curId),
          };
        }
        return item;
      });
    }

    const updated = addChildRecursive(branchesState, parentNodeId, 'branch');
    setBranchesState(updated);
    setExpandedNodes(prev => ({ ...prev, [parentNodeId]: true }));
    setEditingNodeId(newId);
    setEditingText('Ý mới');
    markUnsaved();
    notify('Đã thêm nút con mới');
  };

  const handleStartLink = (nodeId: string) => {
    setLinkingSourceId(nodeId);
    const sourceNode = nodeMap.get(nodeId);
    notify(`Đang chọn liên kết từ: "${sourceNode?.label || nodeId}". Hãy nhấp vào nút thứ hai để hoàn tất nối.`);
  };

  const handleCompleteLink = (targetNodeId: string) => {
    if (!linkingSourceId || linkingSourceId === targetNodeId) {
      setLinkingSourceId(null);
      return;
    }

    const exists = customLinksState.some(
      l =>
        (l.fromId === linkingSourceId && l.toId === targetNodeId) ||
        (l.fromId === targetNodeId && l.toId === linkingSourceId)
    );

    if (exists) {
      notify('Hai nút này đã được nối trước đó.');
      setLinkingSourceId(null);
      return;
    }

    const newLink: CustomLink = {
      id: `link-${Date.now()}`,
      fromId: linkingSourceId,
      toId: targetNodeId,
    };

    const updated = [...customLinksState, newLink];
    setCustomLinksState(updated);
    markUnsaved();

    const fromLabel = nodeMap.get(linkingSourceId)?.label || linkingSourceId;
    const toLabel = nodeMap.get(targetNodeId)?.label || targetNodeId;
    notify(`Đã nối liên kết: "${fromLabel}" ➔ "${toLabel}"`);
    setLinkingSourceId(null);
  };

  const handleDeleteCustomLink = (linkId: string) => {
    const updated = customLinksState.filter(l => l.id !== linkId);
    setCustomLinksState(updated);
    markUnsaved();
    notify('Đã gỡ bỏ đường nối liên kết');
  };

  const handleDeleteNode = (nodeId: string) => {
    if (nodeId === 'root') {
      notify('Không thể xóa nút gốc của sơ đồ');
      return;
    }

    function deleteRecursive(list: MindmapNodeItem[], targetId: string, prefix: string): MindmapNodeItem[] {
      return list
        .filter((item, idx) => {
          const curId = item.id || `${prefix}-${idx}`;
          return curId !== targetId;
        })
        .map((item, idx) => {
          const curId = item.id || `${prefix}-${idx}`;
          const children = item.children || (item.items as any[]) || [];
          if (children.length > 0) {
            return {
              ...item,
              children: deleteRecursive(children, targetId, curId),
            };
          }
          return item;
        });
    }

    const updatedBranches = deleteRecursive(branchesState, nodeId, 'branch');
    const updatedLinks = customLinksState.filter(l => l.fromId !== nodeId && l.toId !== nodeId);

    setBranchesState(updatedBranches);
    setCustomLinksState(updatedLinks);
    markUnsaved();
    notify('Đã xóa nút thành công');
  };

  const handleResetToSaved = () => {
    const saved = lastSavedSnapshotRef.current;
    const restoredRoot = saved.root;
    const restoredBranches = JSON.parse(JSON.stringify(saved.branches || []));
    const restoredLinks = JSON.parse(JSON.stringify(saved.customLinks || []));

    setRootText(restoredRoot);
    setBranchesState(restoredBranches);
    setCustomLinksState(restoredLinks);
    if (saved.orientation) {
      setOrientation(saved.orientation);
    }
    setNodeOffsets({});
    setExpandedNodes({});
    hasLocalModificationsRef.current = false;
    setSaveStatus('idle');
    notify('Đã khôi phục lại phiên bản đã lưu trong CSDL (hủy bỏ các thay đổi chưa lưu).');
  };

  /* ──────────────────────────────────────────────────────────
     PAN, ZOOM & DRAGGING HANDLERS
     ────────────────────────────────────────────────────────── */
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleNodeMouseDown = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (linkingSourceId) {
      handleCompleteLink(id);
      return;
    }

    setDraggingNodeId(id);
    const descendants = getDescendantNodeIds(id, nodes);
    setDragState({
      id,
      startMouse: { x: e.clientX, y: e.clientY },
      descendantIds: descendants,
      initialOffsets: { ...nodeOffsets },
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragState) {
        const deltaX = (e.clientX - dragState.startMouse.x) / zoom;
        const deltaY = (e.clientY - dragState.startMouse.y) / zoom;
        const affectedIds = [dragState.id, ...dragState.descendantIds];

        setNodeOffsets(prev => {
          const next = { ...prev };
          affectedIds.forEach(nodeId => {
            const initial = dragState.initialOffsets[nodeId] || { x: 0, y: 0 };
            const node = nodeMap.get(nodeId);
            const baseNodeX = node ? node.x : 0;
            const baseNodeY = node ? node.y : 0;
            // Prevent dragging offscreen into negative coordinates (keep min 16px from edge)
            const newX = Math.max(-baseNodeX + 16, initial.x + deltaX);
            const newY = Math.max(-baseNodeY + 16, initial.y + deltaY);
            next[nodeId] = {
              x: newX,
              y: newY,
            };
          });
          return next;
        });
      } else if (isPanning) {
        setPan({
          x: e.clientX - panStart.x,
          y: e.clientY - panStart.y,
        });
      }
    };

    const handleMouseUp = () => {
      setIsPanning(false);
      setDraggingNodeId(null);
      setDragState(null);
    };

    if (isPanning || dragState) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, panStart, dragState, zoom]);

  // Mouse Wheel Zoom on Canvas (smooth zoom centered on mouse cursor position)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      setZoom(prevZoom => {
        const nextZoom = Math.min(2.5, Math.max(0.3, Number((prevZoom * zoomFactor).toFixed(3))));
        if (nextZoom === prevZoom) return prevZoom;

        setPan(prevPan => ({
          x: Number((mouseX - ((mouseX - prevPan.x) / prevZoom) * nextZoom).toFixed(1)),
          y: Number((mouseY - ((mouseY - prevPan.y) / prevZoom) * nextZoom).toFixed(1)),
        }));

        return nextZoom;
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const handleZoom = (delta: number) => {
    setZoom(prev => Math.min(2.5, Math.max(0.3, Number((prev + delta).toFixed(2)))));
  };

  const handleResetView = () => {
    setPan({ x: 50, y: 50 });
    setZoom(1);
    setNodeOffsets({});
    notify('Đã đặt lại góc nhìn và vị trí');
  };

  const toggleFullscreen = async () => {
    try {
      const activeElement = document.fullscreenElement || (document as any).webkitFullscreenElement;
      if (activeElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        notify('Đã thoát chế độ toàn màn hình');
      } else if (wrapperRef.current) {
        if (wrapperRef.current.requestFullscreen) {
          await wrapperRef.current.requestFullscreen();
        }
        notify('Chế độ toàn màn hình (Nhấn phím ESC để thoát)');
      }
    } catch {
      setIsFullscreen(prev => !prev);
    }
  };

  const handleExportPng = async () => {
    if (!canvasRef.current) return;
    setIsExporting(true);
    try {
      notify('Đang xuất ảnh PNG sơ đồ tư duy full văn bản…');
      const sanitizedName = (rootText || courseTitle || 'Mindmap')
        .replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_')
        .slice(0, 35);
      await exportElementToPng(
        canvasRef.current,
        `${sanitizedName}_Mindmap_${orientation}`,
        { cropToNodes: true, padding: 48, backgroundColor: '#0c0a1f' }
      );
      notify('Đã tải ảnh PNG thành công!');
    } catch {
      notify('Không thể xuất ảnh PNG. Vui lòng thử lại.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={`artifact notebook-mindmap-wrapper ${isFullscreen ? 'is-fullscreen is-full-window' : ''}`}
      style={
        isFullscreen
          ? undefined
          : {
              height: 'calc(100vh - 230px)',
              minHeight: '580px',
              maxHeight: '85vh',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
            }
      }
    >
      {/* Active Linking Banner Indicator */}
      {linkingSourceId && (
        <div className="mindmap-linking-banner">
          <span>
            🔗 Đang chọn nút để nối từ: <strong>{nodeMap.get(linkingSourceId)?.label || linkingSourceId}</strong>.
            Nhấp vào nút bất kỳ để kết nối!
          </span>
          <button
            type="button"
            className="node-edit-cancel-btn"
            onClick={() => {
              setLinkingSourceId(null);
              notify('Đã hủy chế độ nối');
            }}
          >
            Hủy
          </button>
        </div>
      )}

      {/* Top Header Toolbar */}
      <div
        className="artifact-head"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          overflow: 'visible',
          marginBottom: '10px',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: '220px', flex: '1 1 auto' }}>
          {onReconfigure && (
            <button
              type="button"
              className="mindmap-back-btn"
              onClick={onReconfigure}
              title="Quay lại danh sách hoặc cấu hình tạo sơ đồ"
            >
              <ArrowLeft size={14} />
            </button>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '420px', lineHeight: '30px' }}>
              Sơ đồ tư duy: {rootText || courseTitle}
            </h2>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {levelLabel && <span className="level-badge">{levelLabel}</span>}
              {topic && <small style={{ color: '#94a3b8' }}>Chủ đề: {topic}</small>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Explicit Save to DB Button */}
          <button
            type="button"
            className="reconfigure-btn"
            style={{
              background:
                saveStatus === 'saving'
                  ? 'rgba(234, 179, 8, 0.22)'
                  : saveStatus === 'saved'
                  ? 'rgba(16, 185, 129, 0.25)'
                  : saveStatus === 'unsaved'
                  ? 'rgba(249, 115, 22, 0.25)'
                  : 'rgba(99, 102, 241, 0.25)',
              borderColor:
                saveStatus === 'saving'
                  ? '#eab308'
                  : saveStatus === 'saved'
                  ? '#10b981'
                  : saveStatus === 'unsaved'
                  ? '#f97316'
                  : '#818cf8',
              color:
                saveStatus === 'saving'
                  ? '#fde047'
                  : saveStatus === 'saved'
                  ? '#34d399'
                  : saveStatus === 'unsaved'
                  ? '#fb923c'
                  : '#ffffff',
              fontWeight: 650,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '30px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderRadius: '7px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              transition: 'all 0.2s ease',
            }}
            onClick={handleManualSave}
            title={
              saveStatus === 'saving'
                ? 'Đang gửi dữ liệu đến CSDL...'
                : saveStatus === 'saved'
                ? `Đã lưu thành công vào CSDL ${lastSavedTime ? `lúc ${lastSavedTime.toLocaleTimeString('vi-VN')}` : ''}`
                : saveStatus === 'unsaved'
                ? 'Có thay đổi chưa lưu, bấm để lưu ngay vào CSDL'
                : 'Lưu toàn bộ thay đổi của sơ đồ tư duy vào cơ sở dữ liệu'
            }
            disabled={saveStatus === 'saving'}
          >
            {saveStatus === 'saving' ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                <span>Đang lưu...</span>
              </>
            ) : saveStatus === 'saved' ? (
              <>
                <Check size={13} />
                <span>Đã lưu vào CSDL</span>
              </>
            ) : saveStatus === 'unsaved' ? (
              <>
                <Save size={13} />
                <span>Lưu thay đổi *</span>
              </>
            ) : (
              <>
                <Save size={13} />
                <span>Lưu vào CSDL</span>
              </>
            )}
          </button>

          {/* Orientation Toggle Button */}
          <button
            type="button"
            className="reconfigure-btn"
            style={{
              background: orientation === 'vertical' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(124, 58, 237, 0.2)',
              borderColor: orientation === 'vertical' ? '#38bdf8' : '#8b5cf6',
              color: '#ffffff',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '30px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderRadius: '7px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
            onClick={() => {
              const next = orientation === 'horizontal' ? 'vertical' : 'horizontal';
              setOrientation(next);
              setNodeOffsets({});
              notify(`Đã chuyển hướng hiển thị: ${next === 'horizontal' ? 'Bố cục Ngang (Trái sang Phải)' : 'Bố cục Cột dọc'}`);
              onOrientationChange?.(next);
              markUnsaved();
            }}
            title="Chuyển đổi hướng bố cục sơ đồ tư duy"
          >
            {orientation === 'horizontal' ? <ArrowLeftRight size={13} /> : <ArrowUpDown size={13} />}
            <span>{orientation === 'horizontal' ? 'Bố cục Ngang' : 'Bố cục Dọc'}</span>
          </button>

          {/* Expand / Collapse All */}
          <button
            type="button"
            className="reconfigure-btn"
            onClick={toggleExpandAll}
            title={isAnyNodeCollapsed ? 'Mở rộng toàn bộ nhánh' : 'Thu gọn toàn bộ nhánh'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '30px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderRadius: '7px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {isAnyNodeCollapsed ? <UnfoldHorizontal size={13} /> : <FoldHorizontal size={13} />}
            <span>{isAnyNodeCollapsed ? 'Mở rộng' : 'Thu gọn'}</span>
          </button>

          {/* Reset to Saved in DB View */}
          <button
            type="button"
            className="reconfigure-btn"
            onClick={handleResetToSaved}
            title="Khôi phục lại phiên bản đã lưu gần nhất trong CSDL (Hủy bỏ các thay đổi chưa lưu)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '30px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderRadius: '7px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <RotateCcw size={13} />
            <span>Bản đã lưu</span>
          </button>

          {/* Fullscreen Toggle */}
          <button
            type="button"
            className="reconfigure-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Thu nhỏ lại (ESC)' : 'Xem toàn màn hình (Fullscreen)'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '30px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderRadius: '7px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            <span>{isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}</span>
          </button>

          {/* PNG Export */}
          <button
            type="button"
            className="reconfigure-btn"
            style={{
              background: 'rgba(124, 58, 237, 0.25)',
              borderColor: '#8b5cf6',
              color: '#ffffff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '30px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderRadius: '7px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
            onClick={handleExportPng}
            disabled={isExporting}
          >
            <ImageIcon size={13} />
            <span>{isExporting ? 'Đang xuất…' : 'Xuất ảnh PNG'}</span>
          </button>
        </div>
      </div>

      {/* Interactive Infinite Canvas Container */}
      <div
        className="notebook-canvas-container"
        ref={containerRef}
        onMouseDown={handleCanvasMouseDown}
        style={{
          cursor: isPanning ? 'grabbing' : 'grab',
          minHeight: isFullscreen ? undefined : '500px',
          height: '100%',
          flex: '1 1 0%',
          width: '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Floating Zoom & Pan Controls */}
        <div className="canvas-zoom-controls" style={{ left: '24px', right: 'auto', zIndex: 90 }}>
          <button type="button" onClick={() => handleZoom(0.15)} title="Phóng to" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ZoomIn size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => handleZoom(-0.15)} title="Thu nhỏ" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ZoomOut size={15} />
          </button>
          <button type="button" onClick={handleResetView} title="Đặt lại góc nhìn / Căn giữa" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <RotateCcw size={15} />
          </button>
        </div>

        {/* Scaled & Panned Canvas */}
        <div
          className="notebook-mindmap-canvas"
          ref={canvasRef}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width: `${dynamicCanvasBounds.width}px`,
            height: `${dynamicCanvasBounds.height}px`,
            minHeight: `${dynamicCanvasBounds.height}px`,
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        >
          {/* SVG Connection Lines Layer (z-index: 1, under solid nodes) */}
          <svg
            className="notebook-connections-svg"
            width={dynamicCanvasBounds.width}
            height={dynamicCanvasBounds.height}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              pointerEvents: 'none',
              zIndex: 1,
              overflow: 'visible',
              width: `${dynamicCanvasBounds.width}px`,
              height: `${dynamicCanvasBounds.height}px`,
            }}
          >
            <defs>
              {BRANCH_PALETTES.map(p => (
                <linearGradient key={`branchGradient-${p.id}`} id={`branchGradient-${p.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity="1" />
                  <stop offset="100%" stopColor={p.main} stopOpacity="1" />
                </linearGradient>
              ))}
              <linearGradient id="customGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="1" />
                <stop offset="100%" stopColor="#34d399" stopOpacity="1" />
              </linearGradient>
            </defs>

            {activeConnections.map(conn => {
              const pathD = createCurvedPath(conn.from, conn.to, conn.isCustom);
              const midX = (conn.from.x + conn.to.x) / 2;
              const midY = (conn.from.y + conn.to.y) / 2;
              const palette = BRANCH_PALETTES[(conn.colorIndex ?? 0) % BRANCH_PALETTES.length];

              if (conn.isCustom) {
                return (
                  <g key={conn.id} style={{ pointerEvents: 'all' }}>
                    {/* Outline */}
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#050314"
                      strokeWidth="5"
                      strokeLinecap="round"
                    />
                    {/* Glowing dashed custom connection */}
                    <path
                      d={pathD}
                      fill="none"
                      stroke="url(#customGradient)"
                      strokeWidth="2.4"
                      strokeDasharray="6 4"
                      strokeLinecap="round"
                    />
                    {/* Anchor dots */}
                    <circle cx={conn.from.x} cy={conn.from.y} r="4" fill="#38bdf8" />
                    <circle cx={conn.to.x} cy={conn.to.y} r="4" fill="#34d399" />

                    {/* Interactive delete button in center of custom link */}
                    <g
                      onClick={() => handleDeleteCustomLink(conn.id.replace('custom-link-', ''))}
                      style={{ cursor: 'pointer' }}
                    >
                      <title>Nhấn để gỡ bỏ đường nối này</title>
                      <circle cx={midX} cy={midY} r="9" fill="#181438" stroke="#38bdf8" strokeWidth="1.5" />
                      <text
                        x={midX}
                        y={midY + 3.5}
                        textAnchor="middle"
                        fill="#38bdf8"
                        fontSize="10"
                        fontWeight="bold"
                      >
                        ✕
                      </text>
                    </g>
                  </g>
                );
              }

              const strokeColor = conn.isFromRoot ? `url(#branchGradient-${palette.id})` : palette.main;
              const glowColor = palette.glow;
              const startDotColor = conn.isFromRoot ? '#8b5cf6' : palette.main;
              const endDotColor = palette.main;

              return (
                <g key={conn.id}>
                  {/* Layer 1: Outer dark stroke for high contrast */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#050314"
                    strokeWidth="5.5"
                    strokeLinecap="round"
                  />
                  {/* Layer 2: Glowing aura underlayer colored by parent branch */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke={glowColor}
                    strokeWidth="6"
                    strokeLinecap="round"
                  />
                  {/* Layer 3: Sharp vibrant connection line matching parent branch */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  {/* Connection Anchor Dots matching parent branch color */}
                  <circle cx={conn.from.x} cy={conn.from.y} r="3.5" fill={startDotColor} />
                  <circle cx={conn.to.x} cy={conn.to.y} r="3.5" fill={endDotColor} />
                </g>
              );
            })}
          </svg>

          {/* Interactive HTML Nodes (100% Solid Opaque, z-index: 10) */}
          {nodes.map(node => {
            const offset = nodeOffsets[node.id] || { x: 0, y: 0 };
            const posX = node.x + offset.x;
            const posY = node.y + offset.y;
            const isDragging = draggingNodeId === node.id;
            const isEditing = editingNodeId === node.id;
            const isLinkingSource = linkingSourceId === node.id;
            const isLinkingCandidate = Boolean(linkingSourceId && linkingSourceId !== node.id);

            const nodePalette = BRANCH_PALETTES[(node.colorIndex ?? 0) % BRANCH_PALETTES.length];
            const accentClass = `accent-${((node.colorIndex ?? 0) % 5) + 1}`;
            const depthClass =
              node.depth === 0
                ? 'node-root'
                : node.depth === 1
                ? 'node-branch'
                : node.depth === 2
                ? 'node-subbranch'
                : 'node-leaf';

            const isHovered = hoveredNodeId === node.id;

            return (
              <div
                key={node.id}
                className={`notebook-node ${depthClass} ${accentClass} ${
                  isDragging ? 'is-dragging' : ''
                } ${node.isExpanded ? 'is-expanded' : ''} ${
                  isLinkingSource ? 'is-linking-source' : ''
                } ${isLinkingCandidate ? 'is-linking-target-candidate' : ''}`}
                style={{
                  left: `${posX}px`,
                  top: `${posY}px`,
                  width: `${node.width}px`,
                  minHeight: `${node.height}px`,
                  backgroundColor:
                    node.depth === 0
                      ? undefined
                      : node.depth === 1
                      ? '#181438'
                      : node.depth === 2
                      ? '#141130'
                      : '#120f28',
                  zIndex: isDragging ? 60 : 10,
                  opacity: 1,
                }}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(prev => (prev === node.id ? null : prev))}
                onMouseDown={e => handleNodeMouseDown(node.id, e)}
                onDoubleClick={e => {
                  e.stopPropagation();
                  handleStartEdit(node.id, node.label);
                }}
              >
                {/* Node Quick Action Floating Toolbar (ONLY mounted on hover) */}
                {isHovered && !isEditing && !linkingSourceId && (
                  <div
                    className="node-action-toolbar"
                    style={{
                      position: 'absolute',
                      top: '-34px',
                      right: '0',
                      zIndex: 100,
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: '4px',
                      background: '#1a163a',
                      border: '1px solid #7c3aed',
                      borderRadius: '8px',
                      padding: '3px 6px',
                      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.75)',
                      pointerEvents: 'all',
                      whiteSpace: 'nowrap',
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="node-action-btn"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        background: 'rgba(124, 58, 237, 0.3)',
                        border: '1px solid rgba(139, 92, 246, 0.5)',
                        color: '#ffffff',
                        fontSize: '11px',
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => handleStartEdit(node.id, node.label)}
                      title="Sửa nội dung nút"
                    >
                      <Pencil size={11} /> Sửa
                    </button>
                    <button
                      type="button"
                      className="node-action-btn"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        background: 'rgba(124, 58, 237, 0.3)',
                        border: '1px solid rgba(139, 92, 246, 0.5)',
                        color: '#ffffff',
                        fontSize: '11px',
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => handleAddChild(node.id)}
                      title="Thêm nút con vào mục này"
                    >
                      <Plus size={11} /> Thêm con
                    </button>
                    <button
                      type="button"
                      className="node-action-btn"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        background: 'rgba(124, 58, 237, 0.3)',
                        border: '1px solid rgba(139, 92, 246, 0.5)',
                        color: '#ffffff',
                        fontSize: '11px',
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => handleStartLink(node.id)}
                      title="Tạo đường nối đến nút khác"
                    >
                      <Link2 size={11} /> Nối
                    </button>
                    {node.depth > 0 && (
                      <button
                        type="button"
                        className="node-action-btn delete"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          background: 'rgba(239, 68, 68, 0.25)',
                          border: '1px solid rgba(239, 68, 68, 0.5)',
                          color: '#fca5a5',
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '2px 7px',
                          borderRadius: '5px',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                        onClick={() => handleDeleteNode(node.id)}
                        title="Xóa nút này"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                )}

                {/* Left / Top Anchors */}
                {orientation === 'horizontal' ? (
                  node.depth > 0 && (
                    <div
                      className="node-anchor left"
                      style={{
                        backgroundColor: nodePalette.main,
                        borderColor: '#ffffff',
                        boxShadow: `0 0 6px ${nodePalette.glow}`,
                      }}
                    />
                  )
                ) : (
                  node.depth > 0 && (
                    <div
                      className="node-anchor top"
                      style={{
                        backgroundColor: nodePalette.main,
                        borderColor: '#ffffff',
                        boxShadow: `0 0 6px ${nodePalette.glow}`,
                      }}
                    />
                  )
                )}

                {/* Main Node Content Body */}
                {isEditing ? (
                  <div
                    className="node-edit-box"
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    style={{
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      padding: '2px',
                      boxSizing: 'border-box',
                    }}
                  >
                    <textarea
                      ref={editTextareaRef}
                      className="node-edit-input"
                      value={editingText}
                      onChange={e => setEditingText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSaveEdit(node.id);
                        } else if (e.key === 'Escape') {
                          setEditingNodeId(null);
                        }
                      }}
                      rows={2}
                      style={{
                        width: '100%',
                        background: '#0d0b21',
                        border: '1.5px solid #8b5cf6',
                        borderRadius: '6px',
                        color: '#f8fafc',
                        fontSize: '12.5px',
                        fontWeight: 500,
                        lineHeight: 1.4,
                        padding: '6px 8px',
                        resize: 'vertical',
                        minHeight: '46px',
                        outline: 'none',
                        boxShadow: '0 0 12px rgba(139, 92, 246, 0.45)',
                        boxSizing: 'border-box',
                        fontFamily: 'inherit',
                      }}
                    />
                    <div
                      className="node-edit-actions"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '6px',
                        marginTop: '2px',
                      }}
                    >
                      <button
                        type="button"
                        className="node-edit-confirm-btn"
                        onClick={() => handleSaveEdit(node.id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          background: '#10b981',
                          border: '1px solid #059669',
                          color: '#ffffff',
                          fontSize: '11px',
                          fontWeight: 650,
                          padding: '3px 10px',
                          borderRadius: '5px',
                          cursor: 'pointer',
                          boxShadow: '0 2px 6px rgba(16, 185, 129, 0.35)',
                        }}
                      >
                        <Check size={12} /> Lưu
                      </button>
                      <button
                        type="button"
                        className="node-edit-cancel-btn"
                        onClick={() => setEditingNodeId(null)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'rgba(255, 255, 255, 0.08)',
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          color: '#cbd5e1',
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '3px 8px',
                          borderRadius: '5px',
                          cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="node-content full-text">
                    {node.depth === 0 ? (
                      <>
                        <span className="node-badge">TRỌNG TÂM</span>
                        <strong className="full-text-title">{node.label}</strong>
                      </>
                    ) : node.depth === 1 ? (
                      <>
                        <span
                          className="branch-color-bar"
                          style={{
                            backgroundColor: nodePalette.main,
                            boxShadow: `0 0 8px ${nodePalette.glow}`,
                          }}
                        />
                        <span className="branch-label full-text-content">{node.label}</span>
                      </>
                    ) : (
                      <>
                        <span
                          className="child-color-bar"
                          style={{
                            backgroundColor: nodePalette.main,
                            boxShadow: `0 0 6px ${nodePalette.glow}`,
                          }}
                        />
                        <span className="leaf-label full-text-content">{node.label}</span>
                      </>
                    )}
                  </div>
                )}

                {/* Expand / Collapse Button if node has children */}
                {node.hasChildren && !isEditing && (
                  <button
                    type="button"
                    className="node-toggle-btn"
                    onClick={e => {
                      e.stopPropagation();
                      toggleNodeExpand(node.id);
                    }}
                    title={node.isExpanded ? 'Thu gọn nhánh này' : 'Mở rộng nhánh này'}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {node.isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                )}

                {/* Right / Bottom Anchors */}
                {orientation === 'horizontal' ? (
                  (node.hasChildren || nodesWithOutgoingConns.has(node.id)) && (
                    <div
                      className="node-anchor right"
                      style={{
                        backgroundColor: node.depth === 0 ? '#8b5cf6' : nodePalette.main,
                        borderColor: '#ffffff',
                        boxShadow: `0 0 6px ${node.depth === 0 ? 'rgba(139, 92, 246, 0.5)' : nodePalette.glow}`,
                      }}
                    />
                  )
                ) : (
                  (node.hasChildren || nodesWithOutgoingConns.has(node.id)) && (
                    <div
                      className="node-anchor bottom"
                      style={{
                        backgroundColor: node.depth === 0 ? '#8b5cf6' : nodePalette.main,
                        borderColor: '#ffffff',
                        boxShadow: `0 0 6px ${node.depth === 0 ? 'rgba(139, 92, 246, 0.5)' : nodePalette.glow}`,
                      }}
                    />
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

