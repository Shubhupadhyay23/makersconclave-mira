"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GestureType } from "@/types/gestures";

export interface ProductCard {
  product_id: string;
  title: string;
  price: string;
  image_url: string;
  link: string;
  source: string;
}

interface ProductCarouselProps {
  items: ProductCard[];
  onGesture: (gesture: GestureType, item: ProductCard) => void;
}

type AnimationState = "idle" | "fly-right" | "fly-left" | "pulse" | "shake";

export default function ProductCarousel({
  items,
  onGesture,
}: ProductCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [animation, setAnimation] = useState<AnimationState>("idle");
  const [visible, setVisible] = useState(false);
  const animatingRef = useRef(false);

  // Reset index when items change
  useEffect(() => {
    setActiveIndex(0);
    setAnimation("idle");
    if (items.length > 0) {
      setVisible(true);
    }
  }, [items]);

  // Slide away when all cards are dismissed
  useEffect(() => {
    if (items.length > 0 && activeIndex >= items.length) {
      setVisible(false);
    }
  }, [activeIndex, items.length]);

  const handleGesture = useCallback(
    (gesture: GestureType) => {
      if (animatingRef.current || activeIndex >= items.length) return;
      const item = items[activeIndex];
      animatingRef.current = true;

      // Determine animation type
      let anim: AnimationState = "idle";
      let advances = false;
      if (gesture === "swipe_right") {
        anim = "fly-right";
        advances = true;
      } else if (gesture === "swipe_left") {
        anim = "fly-left";
        advances = true;
      } else if (gesture === "thumbs_up") {
        anim = "pulse";
        advances = false;
      } else if (gesture === "thumbs_down") {
        anim = "shake";
        advances = true;
      }

      setAnimation(anim);
      onGesture(gesture, item);

      // After animation completes, advance card or reset
      setTimeout(() => {
        setAnimation("idle");
        if (advances) {
          setActiveIndex((i) => i + 1);
        }
        animatingRef.current = false;
      }, 500);
    },
    [activeIndex, items, onGesture],
  );

  // Expose handleGesture via ref-like approach on window for parent to call
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__carouselGesture = handleGesture;
    return () => {
      delete (window as unknown as Record<string, unknown>).__carouselGesture;
    };
  }, [handleGesture]);

  if (items.length === 0) return null;
  if (!visible) return null;

  const currentItem = items[activeIndex];
  if (!currentItem) return null;

  const cardStyle = getCardAnimationStyle(animation);

  return (
    <div
      data-testid="product-carousel"
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "22vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "0 24px",
        background:
          "linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 70%, transparent 100%)",
        zIndex: 10,
        overflow: "hidden",
      }}
    >
      {items.map((item, idx) => {
        const isCurrent = idx === activeIndex;
        const isPast = idx < activeIndex;
        if (isPast) return null;

        return (
          <div
            key={item.product_id}
            style={{
              ...(isCurrent ? cardStyle : {}),
              opacity: isCurrent ? 1 : 0.5,
              transform: isCurrent
                ? cardStyle.transform || "scale(1)"
                : "scale(0.85)",
              transition: "all 0.4s ease",
              flexShrink: 0,
              width: 150,
              background: "rgba(255,255,255,0.12)",
              borderRadius: 12,
              overflow: "hidden",
              backdropFilter: "blur(10px)",
              border: isCurrent
                ? "2px solid rgba(255,255,255,0.4)"
                : "1px solid rgba(255,255,255,0.15)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.image_url}
              alt={item.title}
              style={{
                width: "100%",
                height: 110,
                objectFit: "cover",
              }}
            />
            <div style={{ padding: "6px 8px" }}>
              <div
                style={{
                  color: "#fff",
                  fontSize: "0.75rem",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {item.title}
              </div>
              <div
                style={{
                  color: "#fff",
                  fontSize: "0.85rem",
                  fontWeight: 700,
                  marginTop: 2,
                }}
              >
                {item.price}
              </div>
              <div
                style={{
                  color: "rgba(255,255,255,0.5)",
                  fontSize: "0.65rem",
                  marginTop: 2,
                }}
              >
                {item.source}
              </div>
            </div>

            {/* Gesture overlay */}
            {isCurrent && animation === "fly-right" && (
              <GestureOverlay emoji="\u2764\uFE0F" color="rgba(76,175,80,0.7)" />
            )}
            {isCurrent && animation === "fly-left" && (
              <GestureOverlay emoji="\u2716" color="rgba(244,67,54,0.7)" />
            )}
            {isCurrent && animation === "pulse" && (
              <GestureOverlay emoji="\u2764\uFE0F" color="rgba(76,175,80,0.5)" />
            )}
            {isCurrent && animation === "shake" && (
              <GestureOverlay emoji="\uD83D\uDC4E" color="rgba(244,67,54,0.5)" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function GestureOverlay({
  emoji,
  color,
}: {
  emoji: string;
  color: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: color,
        fontSize: "2rem",
        borderRadius: 12,
      }}
    >
      {emoji}
    </div>
  );
}

function getCardAnimationStyle(
  animation: AnimationState,
): React.CSSProperties {
  switch (animation) {
    case "fly-right":
      return {
        transform: "translateX(120%) rotate(15deg)",
        opacity: 0,
        transition: "all 0.4s ease-out",
      };
    case "fly-left":
      return {
        transform: "translateX(-120%) rotate(-15deg)",
        opacity: 0,
        transition: "all 0.4s ease-out",
      };
    case "pulse":
      return {
        transform: "scale(1.1)",
        transition: "all 0.3s ease-out",
      };
    case "shake":
      return {
        transform: "translateX(8px)",
        opacity: 0.5,
        transition: "all 0.3s ease-out",
      };
    default:
      return {};
  }
}
