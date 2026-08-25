export interface Database {
  messages: {
    id: string;
    scope_id: string;
    created: string;
    body: string;
    device: string;
    author: string;
  };
  devices: {
    id: string;
    scope_id: string;
    created: string;
    label: string;
    last_seen: number;
  };
}
