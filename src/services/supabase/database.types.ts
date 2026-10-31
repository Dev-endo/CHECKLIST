export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      assets: {
        Row: {
          asset_short_id: string
          created_at: string
          created_by: string | null
          id: string
          model: string | null
          serial: string
          serial_key: string | null
          unit_code: string | null
        }
        Insert: {
          asset_short_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          serial: string
        }
        Update: {
          asset_short_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          serial?: string
        }
        Relationships: []
      }
      devices: {
        Row: {
          asset_short_id: string | null
          battery_health: number | null
          blame: string | null
          blocked: boolean
          boot_issue: string | null
          consumption: boolean | null
          consumption_note: string | null
          pt_flagged: boolean | null
          pt_note: string | null
          resale: boolean | null
          high_lid: boolean | null
          destination: string | null
          faulty_parts: Json
          kind: string
          maintenances: Json
          notes: string | null
          source_device_id: string | null
          concluded_at: string | null
          created_at: string
          failed_items: string[]
          id: string
          model: string
          phase: Database["public"]["Enums"]["device_phase"]
          results: Json
          serial: string
          status: Database["public"]["Enums"]["device_status"]
          technician: string
          tested_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_short_id?: string | null
          battery_health?: number | null
          blame?: string | null
          blocked?: boolean
          boot_issue?: string | null
          consumption?: boolean | null
          consumption_note?: string | null
          pt_flagged?: boolean | null
          pt_note?: string | null
          resale?: boolean | null
          high_lid?: boolean | null
          destination?: string | null
          faulty_parts?: Json
          kind?: string
          maintenances?: Json
          notes?: string | null
          source_device_id?: string | null
          concluded_at?: string | null
          created_at?: string
          failed_items?: string[]
          id?: string
          model?: string
          phase?: Database["public"]["Enums"]["device_phase"]
          results?: Json
          serial?: string
          status?: Database["public"]["Enums"]["device_status"]
          technician?: string
          tested_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_short_id?: string | null
          battery_health?: number | null
          blame?: string | null
          blocked?: boolean
          boot_issue?: string | null
          consumption?: boolean | null
          consumption_note?: string | null
          pt_flagged?: boolean | null
          pt_note?: string | null
          resale?: boolean | null
          high_lid?: boolean | null
          destination?: string | null
          faulty_parts?: Json
          kind?: string
          maintenances?: Json
          notes?: string | null
          source_device_id?: string | null
          concluded_at?: string | null
          created_at?: string
          failed_items?: string[]
          id?: string
          model?: string
          phase?: Database["public"]["Enums"]["device_phase"]
          results?: Json
          serial?: string
          status?: Database["public"]["Enums"]["device_status"]
          technician?: string
          tested_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          extra_roles: Database["public"]["Enums"]["user_role"][]
          id: string
          name: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          created_at?: string
          email?: string
          extra_roles?: Database["public"]["Enums"]["user_role"][]
          id: string
          name?: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          created_at?: string
          email?: string
          extra_roles?: Database["public"]["Enums"]["user_role"][]
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
      }
      quarantine_checks: {
        Row: {
          asset_short_id: string | null
          created_at: string
          id: string
          result: string
          serial: string
          user_id: string
        }
        Insert: {
          asset_short_id?: string | null
          created_at?: string
          id?: string
          result: string
          serial: string
          user_id?: string
        }
        Update: {
          asset_short_id?: string | null
          created_at?: string
          id?: string
          result?: string
          serial?: string
          user_id?: string
        }
        Relationships: []
      }
      part_allocations: {
        Row: {
          created_at: string
          id: string
          os_id: string
          part: string
          serial: string
          serial_key: string | null
          status: string
          swap_reason: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          os_id: string
          part: string
          serial: string
          status?: string
          swap_reason?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          os_id?: string
          part?: string
          serial?: string
          status?: string
          swap_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_allocations_os_id_fkey"
            columns: ["os_id"]
            isOneToOne: false
            referencedRelation: "service_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      part_loans: {
        Row: {
          borrower: string
          closed_at: string | null
          created_at: string
          id: string
          lent_by: string
          os_id: string
          part: string
          serial: string
          serial_key: string | null
          status: string
        }
        Insert: {
          borrower: string
          closed_at?: string | null
          created_at?: string
          id?: string
          lent_by?: string
          os_id: string
          part: string
          serial: string
          status?: string
        }
        Update: {
          borrower?: string
          closed_at?: string | null
          created_at?: string
          id?: string
          lent_by?: string
          os_id?: string
          part?: string
          serial?: string
          status?: string
        }
        Relationships: []
      }
      part_requests: {
        Row: {
          allocation_id: string | null
          loan_id: string | null
          created_at: string
          id: string
          kind: string
          os_id: string
          part: string
          requested_by: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          serial: string
          serial_key: string | null
          status: string
        }
        Insert: {
          allocation_id?: string | null
          created_at?: string
          id?: string
          kind: string
          os_id: string
          part: string
          requested_by?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          serial: string
          status?: string
        }
        Update: {
          allocation_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          os_id?: string
          part?: string
          requested_by?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          serial?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_requests_os_id_fkey"
            columns: ["os_id"]
            isOneToOne: false
            referencedRelation: "service_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      service_orders: {
        Row: {
          asset_short_id: string | null
          created_at: string
          id: string
          os_key: string | null
          os_number: string
          serial: string
          serial_key: string | null
          user_id: string
        }
        Insert: {
          asset_short_id?: string | null
          created_at?: string
          id?: string
          os_number: string
          serial: string
          user_id?: string
        }
        Update: {
          asset_short_id?: string | null
          created_at?: string
          id?: string
          os_number?: string
          serial?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_presets: {
        Row: {
          email: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          email: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          email?: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      import_assets: {
        Args: { rows: Json }
        Returns: Json
      }
      release_flags: {
        Args: { p_ids: string[] }
        Returns: { device_id: string; released: boolean }[]
      }
      assembly_source: {
        Args: { p_serial: string }
        Returns: {
          device_id: string
          kind: string
          destination: string | null
          status: Database["public"]["Enums"]["device_status"]
          technician: string
          concluded_at: string | null
        }[]
      }
      assembly_report: {
        Args: { p_from?: string; p_to?: string; p_user?: string }
        Returns: Json
      }
      allocate_part: {
        Args: { p_serial: string; p_part: string }
        Returns: string
      }
      request_part: {
        Args: { p_serial: string; p_part: string; p_kind: string; p_allocation_id?: string; p_loan_id?: string }
        Returns: string
      }
      lend_test_part: {
        Args: { p_serial: string; p_part: string; p_borrower: string }
        Returns: string
      }
      stock_borrowers: {
        Args: never
        Returns: { id: string; name: string }[]
      }
      awaiting_allocation: {
        Args: never
        Returns: { id: string; kind: string; model: string | null; sender: string; since: string }[]
      }
      swapped_parts: {
        Args: { p_from?: string; p_to?: string; p_user?: string }
        Returns: {
          reason: string
          part: string
          model: string | null
          technician: string
          user_id: string
          swapped_at: string
        }[]
      }
      return_loan: {
        Args: { p_loan_id: string }
        Returns: undefined
      }
      open_part_loans: {
        Args: never
        Returns: {
          id: string
          part: string
          model: string | null
          os_number: string
          borrower: string
          since: string
        }[]
      }
      complete_allocation: {
        Args: { p_id: string; p_action: string }
        Returns: undefined
      }
      resolve_part_request: {
        Args: { p_id: string; p_decision: string }
        Returns: undefined
      }
      pending_part_requests: {
        Args: never
        Returns: {
          id: string
          kind: string
          part: string
          os_number: string
          model: string | null
          requester: string
          created_at: string
        }[]
      }
      correct_service_order: {
        Args: { p_os_id: string; p_os_number: string }
        Returns: undefined
      }
      os_map: {
        Args: { p_os_id: string }
        Returns: Json
      }
      analysis_parts: {
        Args: { p_item?: string; p_from?: string; p_to?: string; p_user?: string }
        Returns: {
          kind: string
          serial: string
          unit: string | null
          model: string | null
          destination: string | null
          technician: string
          user_id: string
          concluded_at: string | null
          item: string
          detail: string | null
        }[]
      }
      collaborator_summary: {
        Args: { p_from?: string; p_to?: string }
        Returns: {
          user_id: string
          name: string
          maintenance: number
          maintenance_items: number
          disassembly: number
          technical: number
          assembly: number
          quarantine: number
        }[]
      }
      analysis_devices: {
        Args: { p_metric: string; p_from?: string; p_to?: string; p_user?: string }
        Returns: {
          kind: string
          serial: string
          unit: string | null
          model: string | null
          destination: string | null
          status: string
          technician: string
          concluded_at: string | null
          notes: string | null
          maintenances: Json
          parts: Json
          failures: string[] | null
          consumption_note: string | null
          pt_note: string | null
          assembly_rejections: number
        }[]
      }
      disassembly_report: {
        Args: { p_from?: string; p_to?: string; p_user?: string }
        Returns: Json
      }
      maintenance_report: {
        Args: { p_from?: string; p_to?: string; p_user?: string }
        Returns: Json
      }
    }
    Enums: {
      device_phase: "pendente" | "concluido"
      device_status: "incompleto" | "liberado" | "reprovado"
      user_role: "admin" | "supervisor" | "colaborador" | "tecnico" | "montador" | "desmontador" | "estoquista" | "analista" | "tecnico_vidro"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      device_phase: ["pendente", "concluido"],
      device_status: ["incompleto", "liberado", "reprovado"],
      user_role: ["admin", "supervisor", "colaborador", "tecnico", "montador", "desmontador", "estoquista", "analista", "tecnico_vidro"],
    },
  },
} as const
