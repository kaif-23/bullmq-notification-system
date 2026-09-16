import app from "./app.js";
import { db } from "./config/database.js";

const PORT = process.env.PORT || 3000;

db.query("SELECT NOW()")
    .then(() => {
        console.log("PostgreSQL connected");
        
        app.listen(PORT, () => {
            console.log(`notification service is running on http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error("PostgreSQL connection failed:", error);
        process.exit(1);
    });
