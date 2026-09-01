export enum PopupState {
  Authenticated,
  SignedOut,
  AuthenticatedAndManaging,
}

export type SignedOutAction = 'AUTHENTICATE';
export type AuthenticatedAction = 'MANAGE' | 'SIGN_OUT';
export type AuthenticatedAndManagingAction = 'GENERATE' | 'SIGN_OUT';

export type PopupAction =
  | SignedOutAction
  | AuthenticatedAction
  | AuthenticatedAndManagingAction;

type GenericTransitions<Actions extends PopupAction> = {
  [key in Actions]: PopupState;
};

type Transitions = {
  [PopupState.SignedOut]: GenericTransitions<SignedOutAction>;
  [PopupState.Authenticated]: GenericTransitions<AuthenticatedAction>;
  [PopupState.AuthenticatedAndManaging]: GenericTransitions<AuthenticatedAndManagingAction>;
} & { [key in PopupState]: unknown };

export const STATE_MACHINE_TRANSITIONS: Transitions = {
  [PopupState.SignedOut]: {
    AUTHENTICATE: PopupState.Authenticated,
  },
  [PopupState.Authenticated]: {
    MANAGE: PopupState.AuthenticatedAndManaging,
    SIGN_OUT: PopupState.SignedOut,
  },
  [PopupState.AuthenticatedAndManaging]: {
    GENERATE: PopupState.Authenticated,
    SIGN_OUT: PopupState.SignedOut,
  },
};
