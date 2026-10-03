// Zone types
export type ZoneType =
  | 'main_walls'
  | 'columns_pillars'
  | 'parapet_wall'
  | 'balcony_floor'
  | 'balcony_railing'
  | 'gate_grille'
  | 'gate_boundary_wall'
  | 'roof_edge_railing'

export type MeasurementUnit = 'sqft' | 'linear_ft' | 'count'

export type MaterialType =
  | 'paint'
  | 'stone_cladding'
  | 'texture_finish'
  | 'tiles'
  | 'glass_railing'
  | 'metal_railing'
  | 'acp_panels'
  | 'metal_gate'

export type Tier = 'economy' | 'standard' | 'premium'

export type ProjectStatus =
  | 'pending'
  | 'detecting'
  | 'hitl'
  | 'material_selection'
  | 'rendering'
  | 'completed'

// Zone
export interface Zone {
  id: string
  zone_type: ZoneType
  measurement_value: number
  measurement_unit: MeasurementUnit
}

// Material selection per zone
export interface ZoneMaterial {
  zone_id: string
  zone_type: ZoneType
  material_type: MaterialType
  color?: string       // for paint and texture finish
  pattern?: string     // for texture finish only
}

// Cost line item
export interface CostLineItem {
  zone_type: ZoneType
  material_type: MaterialType
  measurement: number
  measurement_unit: MeasurementUnit
  material_rate: number
  material_cost: number
  labor_rate: number
  labor_cost: number
  zone_total: number
  liters_needed?: number    // paint only
  num_tiles?: number        // tiles only
  color?: string
  pattern?: string
}

// Project
export interface Project {
  id: string
  user_id: string
  status: ProjectStatus
  tier?: Tier
  original_image_url?: string
  render_image_url?: string
  render_count: number
  total_cost?: number
  created_at: string
  zones?: Zone[]
  zone_materials?: ZoneMaterial[]
  cost_line_items?: CostLineItem[]
}

// Auth
export interface User {
  id: string
  email: string
  name: string
  credits: number
}
