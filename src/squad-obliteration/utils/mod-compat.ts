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

const TEMP_WIDGET_NAME = 'cipher-ui-node';

function vector(value: [number, number] | [number, number, number] | undefined, fallback: [number, number, number]): mod.Vector {
    const source = value ?? fallback;
    return mod.CreateVector(source[0], source[1], source.length === 2 ? 0 : source[2]);
}

function message(value: mod.Message | string | number | undefined): mod.Message {
    if (value === undefined) return mod.Message('');
    if (typeof value === 'string' || typeof value === 'number') return mod.Message(value);
    return value;
}

function renameTemporaryWidget(name: string): mod.UIWidget {
    const widget = mod.FindUIWidgetWithName(TEMP_WIDGET_NAME);
    mod.SetUIWidgetName(widget, name);
    return widget;
}

function addContainer(node: ParseUiNode, parent: mod.UIWidget): mod.UIWidget {
    const args = [
        TEMP_WIDGET_NAME,
        vector(node.position, [0, 0, 0]),
        vector(node.size, [100, 100, 0]),
        node.anchor ?? mod.UIAnchor.TopLeft,
        parent,
        node.visible ?? true,
        node.padding ?? 0,
        vector(node.bgColor, [0.25, 0.25, 0.25]),
        node.bgAlpha ?? 0.5,
        node.bgFill ?? mod.UIBgFill.Solid,
    ] as const;
    if (node.playerId) mod.AddUIContainer(...args, node.playerId);
    else mod.AddUIContainer(...args);
    return renameTemporaryWidget(node.name);
}

function addText(node: ParseUiNode, parent: mod.UIWidget): mod.UIWidget {
    const args = [
        TEMP_WIDGET_NAME,
        vector(node.position, [0, 0, 0]),
        vector(node.size, [100, 100, 0]),
        node.anchor ?? mod.UIAnchor.TopLeft,
        parent,
        node.visible ?? true,
        node.padding ?? 8,
        vector(node.bgColor, [0.25, 0.25, 0.25]),
        node.bgAlpha ?? 0.5,
        node.bgFill ?? mod.UIBgFill.Solid,
        message(node.textLabel),
        node.textSize ?? 0,
        vector(node.textColor, [1, 1, 1]),
        node.textAlpha ?? 1,
        node.textAnchor ?? mod.UIAnchor.CenterLeft,
    ] as const;
    if (node.playerId) mod.AddUIText(...args, node.playerId);
    else mod.AddUIText(...args);
    return renameTemporaryWidget(node.name);
}

function parseUiNode(node: ParseUiNode, inheritedParent?: mod.UIWidget): mod.UIWidget {
    const parent = node.parent ?? inheritedParent ?? mod.GetUIRoot();
    const widget = node.type === 'Container' ? addContainer(node, parent) : addText(node, parent);
    for (const child of node.children ?? []) parseUiNode(child, widget);
    return widget;
}

function equals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    return mod.Equals(a, b);
}

function getTeamId(team: mod.Team): number {
    if (mod.Equals(team, mod.GetTeam(1))) return 1;
    if (mod.Equals(team, mod.GetTeam(2))) return 2;
    return 0;
}

function showHighlightedGameModeMessage(messageValue: mod.Message, receiver?: mod.Player | mod.Team): void {
    if (!receiver) {
        mod.DisplayHighlightedWorldLogMessage(messageValue);
    } else if (mod.IsType(receiver, mod.Types.Team)) {
        mod.DisplayHighlightedWorldLogMessage(messageValue, receiver as mod.Team);
    } else {
        mod.DisplayHighlightedWorldLogMessage(messageValue, receiver as mod.Player);
    }
}

export const modlib = {
    Equals: equals,
    getPlayerId: (player: mod.Player): number => mod.GetObjId(player),
    getTeamId,
    ParseUI: (node: ParseUiNode): mod.UIWidget => parseUiNode(node),
    ShowHighlightedGameModeMessage: showHighlightedGameModeMessage,
};
