import { useEffect } from "react";
import axios from "axios";
import { serverUrl } from "../App";
import { useDispatch, useSelector } from "react-redux";
import { setItemsInMyCity } from "../redux/userSlice";

function useGetItemByCity() {
  const dispatch = useDispatch()
  const selectedCity = useSelector((state) => state.user.selectedCity);
  const currentCity = useSelector((state) => state.user.currentCity);
  const cityToUse = selectedCity || currentCity; // Fallback to currentCity if selectedCity not set
  
  useEffect(() => {
    if (!cityToUse || cityToUse.trim() === '') return; // Skip if city not available or empty
    const fetchItems = async () => {
      try {
        const result = await axios.get(`${serverUrl}/api/item/get-by-city/${encodeURIComponent(cityToUse)}`, {
          withCredentials: true,
        });
       dispatch(setItemsInMyCity(result.data))
      } catch (error) {
        console.log(error);
      }
    };
    fetchItems();
  }, [cityToUse]);
}

export default useGetItemByCity;
