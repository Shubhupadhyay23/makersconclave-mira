"""Pydantic models for API request/response validation."""

from datetime import date, datetime
from typing import Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr


class UserCreate(BaseModel):
    name: str
    email: str
    phone: Optional[str] = None
    poke_id: Optional[str] = None


class UserResponse(BaseModel):
    id: UUID
    name: str
    email: str
    phone: Optional[str]
    poke_id: Optional[str]
    created_at: datetime


class StyleProfileUpdate(BaseModel):
    brands: List[str] = []
    price_range: Optional[Dict] = None
    style_tags: List[str] = []
    size_info: Optional[Dict] = None
    narrative_summary: Optional[str] = None


class StyleProfileResponse(BaseModel):
    user_id: UUID
    brands: List[str]
    price_range: Optional[dict]
    style_tags: List[str]
    size_info: Optional[dict]
    narrative_summary: Optional[str]


class PurchaseCreate(BaseModel):
    brand: str
    item_name: str
    category: Optional[str] = None
    price: Optional[float] = None
    date: Optional[date] = None
    source_email_id: Optional[str] = None


class PurchaseResponse(BaseModel):
    id: UUID
    user_id: UUID
    brand: str
    item_name: str
    category: Optional[str]
    price: Optional[float]
    date: Optional[date]
    source_email_id: Optional[str]


class SessionResponse(BaseModel):
    id: UUID
    user_id: UUID
    started_at: datetime
    ended_at: Optional[datetime]
    status: str


class ClothingItemCreate(BaseModel):
    name: str
    brand: Optional[str] = None
    price: Optional[float] = None
    image_url: Optional[str] = None
    buy_url: Optional[str] = None
    category: Optional[str] = None
    source: str = "serpapi"


class ClothingItemResponse(BaseModel):
    id: UUID
    name: str
    brand: Optional[str]
    price: Optional[float]
    image_url: Optional[str]
    buy_url: Optional[str]
    category: Optional[str]
    source: Optional[str]


class SessionOutfitResponse(BaseModel):
    id: UUID
    session_id: UUID
    outfit_data: Dict
    reaction: Optional[str]
    clothing_items: List[UUID]


class QueueEntry(BaseModel):
    id: UUID
    user_id: UUID
    position: int
    status: str
    joined_at: datetime


class OnboardingQuestionnaireResponse(BaseModel):
    favorite_brands: List[str] = []
    style_preferences: List[str] = []
    price_range: Dict = {"min": 0, "max": 500}
    size_info: Dict = {}
    gender: str = "unspecified"
    occasions: List[str] = []


class OutfitReactionUpdate(BaseModel):
    reaction: str  # "liked", "disliked", or "skipped"
