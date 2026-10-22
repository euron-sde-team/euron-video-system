import { Link } from "react-router-dom";
import { Button, Empty } from "../components/ui";

export function NotFoundPage() {
  return (
    <Empty
      title="Page not found"
      description="That route does not exist in the console."
      action={
        <Link to="/">
          <Button>Back to overview</Button>
        </Link>
      }
    />
  );
}
