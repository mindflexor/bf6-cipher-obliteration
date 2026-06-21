import {
    Equals,
    ParseUI,
    ShowHighlightedGameModeMessage,
    getPlayerId,
} from '../../vendor/portal-sdk/code/modlib/index.ts';

type ParseUiNode = {
    name: string;
    type: 'Container' | 'Text';
    position?: [number, number] | [number, number, number];
    size?: [number, number] | [number, number, number];
    anchor?: mod.UIAnchor;
    visible?: boolean;
    padding?: number;
    bgColor?: [number, number, number];
    bgAlpha?: number;
    bgFill?: mod.UIBgFill;
    textLabel?: mod.Message | string | number;
    textColor?: [number, number, number];
    textAlpha?: number;
    textSize?: number;
    textAnchor?: mod.UIAnchor;
    parent?: mod.UIWidget;
    playerId?: mod.Player | mod.Team;
    children?: ParseUiNode[];
};

type VendorParseUiNode = Omit<ParseUiNode, 'playerId' | 'children'> & {
    playerId?: mod.Player;
    teamId?: mod.Team;
    children?: VendorParseUiNode[];
};

function normalizeParseUiNode(node: ParseUiNode): VendorParseUiNode {
    const { children, playerId: receiver, ...rest } = node;
    const normalizedNode: VendorParseUiNode = { ...rest };

    if (receiver) {
        if (mod.IsType(receiver, mod.Types.Team)) {
            normalizedNode.teamId = receiver as mod.Team;
        } else {
            normalizedNode.playerId = receiver as mod.Player;
        }
    }

    if (children) {
        normalizedNode.children = children.map((child) => normalizeParseUiNode(child));
    }

    return normalizedNode;
}

function parseUiNode(node: ParseUiNode, parent?: mod.UIWidget): mod.UIWidget {
    const normalizedNode = normalizeParseUiNode({
        ...node,
        ...(parent ? { parent } : {}),
    });

    return ParseUI(normalizedNode) as mod.UIWidget;
}

export function equals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    return Equals(a, b);
}

function compatGetPlayerId(player: mod.Player): number {
    return getPlayerId(player);
}

function compatGetTeamId(team: mod.Team): number {
    if (mod.Equals(team, mod.GetTeam(1))) return 1;
    if (mod.Equals(team, mod.GetTeam(2))) return 2;
    return 0;
}

export function showHighlightedGameModeMessage(message: mod.Message, receiver?: mod.Player | mod.Team): void {
    ShowHighlightedGameModeMessage(message, receiver);
}

export const modlib = {
    Equals: equals,
    getPlayerId: compatGetPlayerId,
    getTeamId: compatGetTeamId,
    ParseUI: parseUiNode,
    ShowHighlightedGameModeMessage: showHighlightedGameModeMessage,
};
