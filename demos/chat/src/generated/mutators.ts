export interface MessagesMutation {
  readonly body?: string;
  readonly device?: string;
  readonly author?: string;
}
export interface MessagesMutators {
  create(id: string, values: MessagesMutation): void;
}

export interface DevicesMutation {
  readonly label?: string;
  readonly last_seen?: number;
}
export interface DevicesMutators {
  create(id: string, values: DevicesMutation): void;
  update(id: string, values: DevicesMutation): void;
  delete(id: string): void;
}
