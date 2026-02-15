"use client";

import { useState } from 'react';
import type { ClothingItem, ClothingCategory } from '@/types/clothing';

interface TestSidebarProps {
  items: ClothingItem[];
  currentIndex: number;
  onAdd: (item: ClothingItem) => void;
  onDelete: (id: string) => void;
  debugMode: boolean;
}

function generateId(): string {
  return `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function TestSidebar({
  items,
  currentIndex,
  onAdd,
  onDelete,
  debugMode,
}: TestSidebarProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ClothingCategory>('tops');

  const handleAdd = () => {
    if (!url.trim()) return;

    onAdd({
      id: generateId(),
      category,
      imageUrl: url.trim(),
      name: name.trim() || 'Unnamed item',
    });

    // Reset form
    setUrl('');
    setName('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAdd();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: 350,
        background: '#1a1a1a',
        padding: 24,
        overflowY: 'auto',
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        zIndex: 100,
        borderLeft: '1px solid #333',
      }}
    >
      <h2 style={{ marginTop: 0, marginBottom: 24, fontSize: '1.5rem' }}>
        Test Controls
      </h2>

      {/* Add clothing form */}
      <div
        style={{
          marginBottom: 32,
          padding: 16,
          background: '#252525',
          borderRadius: 8,
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: '1rem' }}>
          Add Clothing Item
        </h3>

        <input
          type="text"
          placeholder="Image URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 12,
            background: '#1a1a1a',
            border: '1px solid #444',
            borderRadius: 6,
            color: '#fff',
            fontSize: '14px',
          }}
        />

        <input
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 12,
            background: '#1a1a1a',
            border: '1px solid #444',
            borderRadius: 6,
            color: '#fff',
            fontSize: '14px',
          }}
        />

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ClothingCategory)}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 12,
            background: '#1a1a1a',
            border: '1px solid #444',
            borderRadius: 6,
            color: '#fff',
            fontSize: '14px',
          }}
        >
          <option value="tops">Tops</option>
          <option value="bottoms">Bottoms</option>
        </select>

        <button
          onClick={handleAdd}
          disabled={!url.trim()}
          style={{
            width: '100%',
            padding: '10px 16px',
            background: url.trim() ? '#0070f3' : '#333',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: url.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Add Item
        </button>
      </div>

      {/* Current items list */}
      <div style={{ marginBottom: 32 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: '1rem' }}>
          Current Outfits ({items.length})
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((item, idx) => {
            const outfit = items[idx];
            const isActive = idx === currentIndex;

            return (
              <div
                key={item.id}
                style={{
                  padding: 12,
                  background: isActive ? '#2a2a2a' : '#222',
                  borderRadius: 8,
                  border: isActive ? '2px solid #0070f3' : '1px solid #333',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {isActive ? '▶ ' : ''}
                      Outfit {idx + 1}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#999',
                      }}
                    >
                      {Array.isArray(outfit) ? `${outfit.length} items` : '1 item'}
                    </div>
                  </div>

                  <button
                    onClick={() => onDelete(item.id)}
                    style={{
                      padding: '4px 8px',
                      background: '#ff4444',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>

                {/* Thumbnail */}
                <img
                  src={item.imageUrl}
                  alt={item.name}
                  style={{
                    width: 60,
                    height: 60,
                    objectFit: 'contain',
                    background: '#333',
                    borderRadius: 4,
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />

                <div style={{ fontSize: '12px', marginTop: 8, color: '#ccc' }}>
                  {item.name}
                </div>
                <div style={{ fontSize: '11px', color: '#666' }}>
                  {item.category}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Keyboard shortcuts */}
      <div
        style={{
          padding: 16,
          background: '#252525',
          borderRadius: 8,
          fontSize: '12px',
          color: '#999',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: '0.9rem', color: '#ccc' }}>
          Keyboard Shortcuts
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <strong style={{ color: '#fff' }}>← →</strong> Cycle outfits
          </div>
          <div>
            <strong style={{ color: '#fff' }}>1-9</strong> Jump to outfit
          </div>
          <div>
            <strong style={{ color: '#fff' }}>D</strong> Toggle debug{' '}
            {debugMode ? '(ON)' : '(OFF)'}
          </div>
          <div>
            <strong style={{ color: '#fff' }}>F</strong> Fullscreen
          </div>
          <div>
            <strong style={{ color: '#fff' }}>R</strong> Reset
          </div>
        </div>
      </div>
    </div>
  );
}
