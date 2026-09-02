import type { Component } from 'vue'
import {
  Bell, BookOpen, Bug, Calendar, Camera, Code, FileText, Flag, Globe, Heart, Image, Lightbulb, ListTodo, Mail, Megaphone,
  MessageSquare, Mic, Music, Newspaper, Palette, Phone, Presentation, Rocket, ShoppingCart, Star, Ticket, Users, Video, Wrench, Zap
} from '@lucide/vue'
import type { TicketTypeIconName } from '~~/shared/types/domain'

/**
 * The curated set, resolved to components. Named imports on purpose: `@lucide/vue` exports
 * an index of every icon, and reaching into that would ship all fifteen hundred of them.
 * `ticketTypeIconNames` in the shared types is the list the server validates against; this
 * record is typed by it, so adding a name there without a component here does not compile.
 */
export const TICKET_TYPE_ICON_COMPONENTS: Record<TicketTypeIconName, Component> = {
  Ticket, Mail, Megaphone, ListTodo, Bug, Lightbulb, Calendar, FileText, Image, Video,
  Code, Star, Flag, Bell, Rocket, Heart, MessageSquare, Phone, Globe, ShoppingCart,
  Wrench, Zap, BookOpen, Camera, Presentation, Newspaper, Palette, Music, Mic, Users
}
