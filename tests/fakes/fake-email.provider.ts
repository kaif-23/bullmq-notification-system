import type {
    EmailProvider,
    EmailSendRequest,
    SendEmailResult
} from "../../src/types/email-provider.types.js";

type FakeEmailOutcome = SendEmailResult | Error;

export class FakeEmailProvider implements EmailProvider {
    public calls = 0;
    private readonly outcomes: FakeEmailOutcome[];

    constructor(outcomes: FakeEmailOutcome | FakeEmailOutcome[] = { status: "sent" }) {
        this.outcomes = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
    }

    async send(_request: EmailSendRequest): Promise<SendEmailResult> {
        this.calls += 1;
        const outcome = this.outcomes.shift() ?? { status: "sent" };

        if (outcome instanceof Error) {
            throw outcome;
        }

        return outcome;
    }
}
