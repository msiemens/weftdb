export interface InternalDatabase {
  messages: {
    id: string;
    _weft_hlc_id: string | null;
    scope_id: string;
    _weft_hlc_scope_id: string | null;
    created: string;
    _weft_hlc_created: string | null;
    body: string;
    _weft_hlc_body: string | null;
    device: string;
    _weft_hlc_device: string | null;
    author: string;
    _weft_hlc_author: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: number;
    _weft_dirty: number;
  };
  devices: {
    id: string;
    _weft_hlc_id: string | null;
    scope_id: string;
    _weft_hlc_scope_id: string | null;
    created: string;
    _weft_hlc_created: string | null;
    label: string;
    _weft_hlc_label: string | null;
    last_seen: number;
    _weft_hlc_last_seen: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: number;
    _weft_dirty: number;
  };
}
