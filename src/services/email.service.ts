export async function sendEmail(
    email: string,
    timeoutMs = 3000
) {
    await Promise.race([
        new Promise((resolve) =>
            setTimeout(resolve, 100)
        ),

        new Promise((_, reject) =>
            setTimeout(
                () => reject(
                    new Error("Email provider timeout")
                ),
                timeoutMs
            )
        )
    ]);

    console.log(`Email sent to ${email}`);
}