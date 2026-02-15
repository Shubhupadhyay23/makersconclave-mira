"use client";

import { useState } from 'react';
import type { ClothingItem, ClothingCategory } from '@/types/clothing';

interface OutfitResult {
  outfit_name: string;
  voice: string;
  items: ClothingItem[];
}

interface TestSidebarProps {
  outfits: ClothingItem[][];
  currentIndex: number;
  onAddOutfit: (items: ClothingItem[]) => void;
  onSelect: (index: number) => void;
  onDelete: (id: string) => void;
  debugMode: boolean;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:8000';

export function TestSidebar({
  outfits,
  currentIndex,
  onAddOutfit,
  onSelect,
  onDelete,
  debugMode,
}: TestSidebarProps) {
  // Recommendation state
  const [brands, setBrands] = useState('Nike, Zara, H&M');
  const [gender, setGender] = useState('mens');
  const [styleNotes, setStyleNotes] = useState('casual streetwear');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [voiceMessages, setVoiceMessages] = useState<{ outfit: string; text: string }[]>([]);

  const handleGetRecs = async () => {
    if (isLoading) return;

    setIsLoading(true);
    setLoadingStep('Searching for clothing...');

    try {
      const brandList = brands.split(',').map((b) => b.trim()).filter(Boolean);

      setLoadingStep('Serper search + Claude styling + Nano Banana flat lays...');

      const res = await fetch(`${BACKEND_URL}/api/test/recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brands: brandList,
          gender,
          style_notes: styleNotes,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const resultOutfits: OutfitResult[] = data.outfits || [];

      if (resultOutfits.length === 0) {
        setLoadingStep('No outfits generated. Try different brands.');
        return;
      }

      // Add each outfit to the canvas and collect voice messages
      const newVoice: { outfit: string; text: string }[] = [];
      for (const outfit of resultOutfits) {
        const items: ClothingItem[] = outfit.items.map((item) => ({
          id: item.id,
          category: item.category as ClothingCategory,
          imageUrl: item.imageUrl,
          name: item.name || item.title,
        }));

        if (items.length > 0) {
          onAddOutfit(items);
        }

        if (outfit.voice) {
          newVoice.push({ outfit: outfit.outfit_name, text: outfit.voice });
        }
      }

      setVoiceMessages(newVoice);
      setLoadingStep(`Added ${resultOutfits.length} outfits`);
    } catch (err) {
      setLoadingStep(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
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
        Mira Test
      </h2>

      {/* Get Recommendations */}
      <div
        style={{
          marginBottom: 24,
          padding: 16,
          background: '#1a2a1a',
          borderRadius: 8,
          border: '1px solid #2a4a2a',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: '1rem' }}>
          Get Recommendations
        </h3>

        <input
          type="text"
          placeholder="Brands (comma-separated)"
          value={brands}
          onChange={(e) => setBrands(e.target.value)}
          disabled={isLoading}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 8,
            background: '#1a1a1a',
            border: '1px solid #444',
            borderRadius: 6,
            color: '#fff',
            fontSize: '13px',
          }}
        />

        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value)}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: '#1a1a1a',
              border: '1px solid #444',
              borderRadius: 6,
              color: '#fff',
              fontSize: '13px',
            }}
          >
            <option value="mens">Mens</option>
            <option value="womens">Womens</option>
            <option value="unisex">Unisex</option>
          </select>
        </div>

        <input
          type="text"
          placeholder="Style notes (e.g. casual streetwear)"
          value={styleNotes}
          onChange={(e) => setStyleNotes(e.target.value)}
          disabled={isLoading}
          onKeyDown={(e) => e.key === 'Enter' && handleGetRecs()}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 12,
            background: '#1a1a1a',
            border: '1px solid #444',
            borderRadius: 6,
            color: '#fff',
            fontSize: '13px',
          }}
        />

        <button
          onClick={handleGetRecs}
          disabled={isLoading}
          style={{
            width: '100%',
            padding: '10px 16px',
            background: isLoading ? '#555' : '#22aa22',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {isLoading ? loadingStep : 'Get Outfit Recommendations'}
        </button>

        {!isLoading && loadingStep && (
          <div
            style={{
              marginTop: 8,
              fontSize: '12px',
              color: loadingStep.startsWith('Error') ? '#ff6666' : '#aaffaa',
            }}
          >
            {loadingStep}
          </div>
        )}
      </div>

      {/* Mira Voice Messages */}
      {voiceMessages.length > 0 && (
        <div
          style={{
            marginBottom: 24,
            padding: 16,
            background: '#2a1a2a',
            borderRadius: 8,
            border: '1px solid #4a2a4a',
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: '1rem' }}>
            Mira Says
          </h3>
          {voiceMessages.map((msg, idx) => (
            <div
              key={idx}
              style={{
                marginBottom: idx < voiceMessages.length - 1 ? 12 : 0,
                padding: 10,
                background: '#1a1a1a',
                borderRadius: 6,
                fontSize: '13px',
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 600, color: '#cc88ff', marginBottom: 4, fontSize: '12px' }}>
                {msg.outfit}
              </div>
              <div style={{ color: '#ddd' }}>
                &ldquo;{msg.text}&rdquo;
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Outfits list */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: '1rem' }}>
          Outfits ({outfits.length})
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {outfits.map((outfit, idx) => {
            const isActive = idx === currentIndex;

            return (
              <div
                key={`outfit-${idx}`}
                onClick={() => onSelect(idx)}
                style={{
                  padding: 12,
                  background: isActive ? '#2a2a2a' : '#222',
                  borderRadius: 8,
                  border: isActive ? '2px solid #0070f3' : '1px solid #333',
                  cursor: 'pointer',
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
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {isActive ? '▶ ' : ''}
                      Outfit {idx + 1}
                    </div>
                    <div style={{ fontSize: '11px', color: '#999' }}>
                      {outfit.map((i) => i.category).join(' + ')}
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(outfit[0]?.id);
                    }}
                    style={{
                      padding: '4px 8px',
                      background: '#ff4444',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      fontSize: '11px',
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>

                {/* Thumbnails */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {outfit.map((item) => (
                    <div key={item.id} style={{ flex: 1, minWidth: 0 }}>
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        style={{
                          width: '100%',
                          height: 60,
                          objectFit: 'contain',
                          background: '#333',
                          borderRadius: 4,
                        }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                      <div
                        style={{
                          fontSize: '10px',
                          color: '#ccc',
                          marginTop: 4,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.name}
                      </div>
                      <div style={{ fontSize: '10px', color: '#666' }}>
                        {item.category}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Keyboard shortcuts */}
      <div
        style={{
          padding: 12,
          background: '#252525',
          borderRadius: 8,
          fontSize: '11px',
          color: '#999',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div><strong style={{ color: '#fff' }}>← →</strong> Cycle outfits</div>
          <div><strong style={{ color: '#fff' }}>1-9</strong> Jump to outfit</div>
          <div><strong style={{ color: '#fff' }}>D</strong> Debug {debugMode ? '(ON)' : '(OFF)'}</div>
          <div><strong style={{ color: '#fff' }}>F</strong> Fullscreen</div>
        </div>
      </div>
    </div>
  );
}
